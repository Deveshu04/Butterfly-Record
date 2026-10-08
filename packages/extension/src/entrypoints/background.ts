// Coordinator only. Chrome terminates the worker when idle, so durable state lives
// in chrome.storage.session (lib/session.ts) or in the recording host.

import { ulid } from '@butterfly-record/core'

import {
  HOST_BUSY,
  SCOPE_LABELS,
  fail,
  isFor,
  ok,
  type BackgroundRequest,
  type CaptureOptions,
  type CropRect,
  type HostKind,
  type HostRequest,
  type HostStatus,
  type RecordScope,
  type RecordingPhase,
  type Reply,
} from '../lib/messages.ts'
import {
  clearSession,
  clearSessionFor,
  elapsedSeconds,
  isActive,
  isStale,
  readSession,
  writeSession,
  writeSessionFor,
  type SessionRecord,
} from '../lib/session.ts'
import { writeFolderNeedsReconnect } from '../lib/save-destination.ts'
import { loadSettings, type Settings } from '../lib/settings.ts'

const OFFSCREEN_PATH = 'offscreen.html'
const RECORDER_PATH = 'recorder.html'
const RECORD_COLOUR = '#e5484d'
const RECORDER_TAB_TIMEOUT_MS = 8000
const PENDING_DOWNLOAD_PREFIX = 'pending-download:'

/** A download of a host's blob URL, in storage.session so a worker restart cannot lose it. */
interface PendingDownload {
  host: HostKind
  sessionId: string
  /** Closed once the download settles; null for the offscreen host. */
  recorderTabId: number | null
}

export default defineBackground(() => {
  // No popup: a popup closes when focus moves, so it cannot host a camera preview.
  // The click also grants activeTab, which makes tabCapture legal on this tab.
  chrome.action.onClicked.addListener((tab) => void onActionClicked(tab))

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-recording') void toggleRecording()
    if (command === 'pause-recording') void togglePause()
    if (command === 'cancel-recording') void cancelRecording()
    if (command === 'toggle-draw') void toggleDraw()
  })

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isFor(message, 'background')) return false
    handle(message, sender).then(
      (value) => sendResponse(ok(value)),
      (error) => sendResponse(fail(error)),
    )
    return true
  })

  chrome.tabs.onRemoved.addListener((tabId) => void onTabClosed(tabId))

  // Registered at top level: a listener added mid-download is lost if the worker restarts.
  chrome.downloads.onChanged.addListener((delta) => void settleDownload(delta))

  // Navigation destroys the injected overlay; re-inject it while recording.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'complete') return
    void readSession().then(async (session) => {
      if (!isActive(session) || session.tabId !== tabId) return
      if (!(await loadSettings()).showHud) return
      await injectOverlay(tabId)
    })
  })

  chrome.runtime.onStartup.addListener(() => void resetBadge())
  chrome.runtime.onInstalled.addListener(() => void resetBadge())
})

/** Guards the double-create race: two fast clicks both see "no document". */
let creatingOffscreen: Promise<void> | null = null

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  })
  return contexts.length > 0
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  if (creatingOffscreen) return creatingOffscreen

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        // Required for getDisplayMedia in the offscreen document.
        chrome.offscreen.Reason.DISPLAY_MEDIA,
        chrome.offscreen.Reason.BLOBS,
        chrome.offscreen.Reason.WORKERS,
      ],
      justification:
        'Screen recording needs MediaRecorder, Web Audio and a worker, none of which a service worker can host.',
    })
    .finally(() => {
      creatingOffscreen = null
    })

  return creatingOffscreen
}

/** Resolved by the recorder tab's `recorder-tab-ready` message. */
let recorderTabReady: (() => void) | null = null

async function ensureRecorderTab(): Promise<number> {
  const { recorderTabId } = await readSession()
  if (recorderTabId !== null) {
    try {
      const tab = await chrome.tabs.get(recorderTabId)
      if (tab.id !== undefined) return tab.id
    } catch {
      // Closed; fall through and open a new one.
    }
  }

  const ready = new Promise<void>((resolve) => {
    recorderTabReady = resolve
  })

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(RECORDER_PATH),
    pinned: true,
    active: false,
  })
  if (tab.id === undefined) throw new Error('Could not open the recorder tab.')

  // Do not hang if the page never reports ready.
  await Promise.race([ready, delay(RECORDER_TAB_TIMEOUT_MS)])
  recorderTabReady = null

  await writeSession({ recorderTabId: tab.id })
  return tab.id
}

/**
 * chooseDesktopMedia rejects with "targetTab doesn't have URL field set" when
 * `tab.url` is missing (still loading, or withheld for chrome-extension:// pages),
 * so wait briefly and then fall back to the known URL.
 */
async function recorderTabForPicker(tabId: number): Promise<chrome.tabs.Tab> {
  const expected = chrome.runtime.getURL(RECORDER_PATH)

  for (let attempt = 0; attempt < 10; attempt++) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url) return tab
    await delay(100)
  }

  console.warn('[butterfly-record] recorder tab reported no URL; using the known one')
  return { ...(await chrome.tabs.get(tabId)), url: expected }
}

async function closeRecorderTab(tabId: number | null): Promise<void> {
  if (tabId === null) return
  // Forget it first, so onTabClosed does not report an interrupted recording.
  const session = await readSession()
  if (session.recorderTabId === tabId) await writeSession({ recorderTabId: null })
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // Already gone.
  }
}

/** The pinned recorder tab that sent a message, or null for any other sender. */
function recorderTabOf(sender: chrome.runtime.MessageSender): number | null {
  const tabId = sender.tab?.id
  if (tabId === undefined) return null
  return sender.url?.startsWith(chrome.runtime.getURL(RECORDER_PATH)) ? tabId : null
}

function toHost<T>(request: HostRequest): Promise<T> {
  return chrome.runtime.sendMessage<HostRequest, Reply<T>>(request).then((reply) => {
    if (!reply?.ok) throw new Error(reply?.error ?? 'The recorder did not respond.')
    return reply.value
  })
}

async function toActiveHost<T>(
  type: 'stop' | 'cancel' | 'pause' | 'resume' | 'status',
): Promise<T> {
  const { host } = await readSession()
  if (!host) throw new Error('Nothing is recording.')
  return toHost<T>({ target: host, type } as HostRequest)
}

/** Only known-blocked schemes; `tab.url` is often empty on ordinary pages. */
function isBlockedPage(url: string | undefined): boolean {
  if (!url) return false
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source|file):/i.test(url)) return true
  return (
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore')
  )
}

/** The API takes the enum's string values, not the enum type itself. */
type DesktopSource = `${chrome.desktopCapture.DesktopCaptureSourceType}`

/** `targetTab` is required from a service worker; the stream is bound to its origin. */
function chooseDesktopMedia(
  sources: DesktopSource[],
  targetTab: chrome.tabs.Tab,
): Promise<{ streamId: string; canRequestAudio: boolean }> {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(sources, targetTab, (streamId, options) => {
      const failure = chrome.runtime.lastError
      if (failure) {
        reject(new Error(failure.message ?? 'The screen picker could not be opened.'))
        return
      }
      if (!streamId) {
        reject(new Error('cancelled'))
        return
      }
      resolve({ streamId, canRequestAudio: options?.canRequestAudioTrack ?? false })
    })
  })
}

// Injected on demand rather than declared in the manifest, so nothing runs on
// pages that are never recorded. The path is WXT's build output.
const OVERLAY_FILES = ['content-scripts/overlay.js']

async function injectOverlay(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: OVERLAY_FILES })
    return true
  } catch (error) {
    // chrome://, the Web Store and the PDF viewer refuse injection.
    console.warn('[butterfly-record] could not inject the overlay', error)
    return false
  }
}

async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return

  // If the overlay is already mounted, toggle it instead of injecting a second copy.
  const alreadyOpen = await chrome.tabs
    .sendMessage(tab.id, { target: 'overlay', type: 'toggle-panel' })
    .then(() => true)
    .catch(() => false)
  if (alreadyOpen) return

  if (!isBlockedPage(tab.url) && (await injectOverlay(tab.id))) return

  // Nowhere on this page to show a message, so explain with a notification.
  await notify(
    'Butterfly Record can’t record this page',
    'Chrome blocks extensions from its own pages (chrome://, the Web Store, the PDF viewer). Switch to an ordinary web page and click the butterfly again.',
  )
  await flashBadge('—')
}

async function flashBadge(text: string): Promise<void> {
  await setBadge(text)
  setTimeout(() => void resetBadge(), 4000)
}

/** Started by the host on `capture-ready`, once Chrome's picker has closed. */
function countdownFor(settings: Settings): number {
  return settings.countdownSeconds * 1000
}

function captureFor(settings: Settings, crop: CropRect | null): CaptureOptions {
  return {
    maxHeight: settings.maxHeight,
    frameRate: settings.frameRate,
    encoder: settings.encoder,
    microphoneId: settings.microphoneId,
    crop,
  }
}

/** Which host took the start, so a start that was cancelled meanwhile can be undone. */
interface StartedHost {
  host: HostKind
  recorderTabId: number | null
}

/** Writes for a start in progress; throws 'cancelled' once Stop, Delete or Restart ended it. */
async function updateStart(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
  const written = await writeSessionFor(sessionId, patch, (session) => session.phase === 'starting')
  if (!written) throw new Error('cancelled')
}

async function startTabRecording(
  sessionId: string,
  settings: Settings,
  capture: CaptureOptions,
): Promise<StartedHost> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab to record.')
  if (isBlockedPage(tab.url)) {
    throw new Error('Chrome does not allow recording this page. Try an ordinary web page.')
  }

  // A tab-capture stream ID expires within seconds, so mint it before anything
  // slow; the countdown runs in the host after the stream is open.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })

  const sourceLabel = tab.title ?? 'This tab'
  await updateStart(sessionId, {
    host: 'offscreen',
    tabId: tab.id,
    sourceLabel,
    cameraOn: settings.cameraEnabled,
  })

  await ensureOffscreen()
  if (settings.showHud) await injectOverlay(tab.id)
  const countdownMs = countdownFor(settings)

  await toHost<HostStatus>({
    target: 'offscreen',
    type: 'start-tab',
    sessionId,
    streamId,
    sourceLabel,
    withMicrophone: settings.microphoneEnabled,
    withTabAudio: settings.tabAudioEnabled,
    countdownMs,
    capture,
  })
  return { host: 'offscreen', recorderTabId: null }
}

/** Opens the picker over the current page; startRecording falls back to the recorder tab. */
async function startDisplayRecording(
  sessionId: string,
  scope: Exclude<RecordScope, 'tab'>,
  settings: Settings,
  capture: CaptureOptions,
): Promise<StartedHost> {
  await ensureOffscreen()

  const sourceLabel = scope === 'screen' ? 'Entire screen' : 'Application window'
  await updateStart(sessionId, { host: 'offscreen', sourceLabel, cameraOn: settings.cameraEnabled })

  const [viewing] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (settings.showHud && viewing?.id !== undefined && !isBlockedPage(viewing.url)) {
    await updateStart(sessionId, { tabId: viewing.id })
    await injectOverlay(viewing.id)
  }
  const countdownMs = countdownFor(settings)

  await toHost<HostStatus>({
    target: 'offscreen',
    type: 'start-display',
    sessionId,
    scope,
    withMicrophone: settings.microphoneEnabled,
    countdownMs,
    capture,
  })
  return { host: 'offscreen', recorderTabId: null }
}

async function startDesktopRecording(
  sessionId: string,
  scope: Exclude<RecordScope, 'tab'>,
  settings: Settings,
  capture: CaptureOptions,
): Promise<StartedHost> {
  // 'audio' adds the "Also share system audio" checkbox, which Chrome offers
  // for whole screens on Windows but not for individual windows.
  const sources: DesktopSource[] = scope === 'screen' ? ['screen', 'audio'] : ['window']

  // The picker binds the stream to this tab, which then redeems the ID.
  const recorderTabId = await ensureRecorderTab()
  const recorderTab = await recorderTabForPicker(recorderTabId)

  let choice: { streamId: string; canRequestAudio: boolean }
  try {
    choice = await chooseDesktopMedia(sources, recorderTab)
  } catch (error) {
    await closeRecorderTab(recorderTabId)
    throw error instanceof Error && error.message === 'cancelled'
      ? new Error('cancelled')
      : error
  }

  const sourceLabel = scope === 'screen' ? 'Entire screen' : 'Application window'
  try {
    await updateStart(sessionId, {
      host: 'recorder-tab',
      sourceLabel,
      cameraOn: settings.cameraEnabled,
    })

    const [viewing] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (settings.showHud && viewing?.id !== undefined && !isBlockedPage(viewing.url)) {
      await updateStart(sessionId, { tabId: viewing.id })
      await injectOverlay(viewing.id)
    }
    const countdownMs = countdownFor(settings)

    await toHost<HostStatus>({
      target: 'recorder-tab',
      type: 'start-desktop',
      sessionId,
      streamId: choice.streamId,
      scope,
      sourceLabel,
      withMicrophone: settings.microphoneEnabled,
      withSystemAudio: choice.canRequestAudio,
      countdownMs,
      capture,
    })
  } catch (error) {
    // A failed start keeps the tab open to show why; a cancelled one has nothing to show.
    if (message(error) === 'cancelled') await closeRecorderTab(recorderTabId)
    throw error
  }
  return { host: 'recorder-tab', recorderTabId }
}

async function hostPhase(host: HostKind | null): Promise<RecordingPhase | null> {
  if (host === null) return null
  try {
    return (await toHost<HostStatus>({ target: host, type: 'status' })).phase
  } catch {
    return null
  }
}

/** Clears a stale busy session, which would otherwise block every later Start. */
async function reconcileSession(): Promise<SessionRecord> {
  const session = await readSession()
  if (!isActive(session)) return session

  if (isStale(session)) {
    // Finalizing and saving a long take can outlast the clock.
    if (
      session.phase === 'finalizing' &&
      session.host !== null &&
      (await hostPhase(session.host)) === 'finalizing'
    ) {
      return session
    }
    console.warn('[butterfly-record] clearing a stale session', session)
    await clearSession()
    await resetBadge()
    return readSession()
  }

  // Recordings can legitimately run for hours, so ask the host instead of a clock.
  if (session.host) {
    try {
      const status = await toHost<HostStatus>({ target: session.host, type: 'status' })
      if (status.phase !== 'idle') return session
    } catch {
      // Host is gone.
    }
    console.warn('[butterfly-record] host is gone; clearing session', session)
    await clearSession()
    await resetBadge()
    return readSession()
  }

  return session
}

async function startRecording(
  scope: RecordScope,
  crop: CropRect | null = null,
): Promise<SessionRecord> {
  const existing = await reconcileSession()
  if (isActive(existing)) return existing

  const settings = await loadSettings()
  const capture = captureFor(settings, crop)
  const sessionId = ulid()
  await writeSession({
    phase: 'starting',
    sessionId,
    scope,
    host: null,
    tabId: null,
    sourceLabel: SCOPE_LABELS[scope],
    // Set when capture starts, so time in the picker is not counted.
    startedAt: null,
    requestedAt: Date.now(),
    finalizingAt: null,
    pausedMs: 0,
    pausedAt: null,
    countdownEndsAt: null,
    micMuted: false,
    cameraOn: false,
    error: null,
  })

  let started: StartedHost
  try {
    if (scope === 'tab') {
      started = await startTabRecording(sessionId, settings, capture)
    } else {
      try {
        started = await startDisplayRecording(sessionId, scope, settings, capture)
      } catch (error) {
        // A dismissed picker is a cancellation; only an API rejection takes the fallback.
        if (isCancellation(error)) throw new Error('cancelled')
        if (message(error) === HOST_BUSY) throw error
        console.warn(
          '[butterfly-record] getDisplayMedia unavailable in the offscreen document; falling back to the pinned recorder tab',
          error,
        )
        started = await startDesktopRecording(sessionId, scope, settings, capture)
      }
    }
  } catch (error) {
    // Also logged, since the requesting UI may be gone before this fails.
    if (message(error) !== 'cancelled') {
      console.error('[butterfly-record] could not start recording', error)
    }
    await endSession(sessionId)
    throw error
  }

  const recording = await writeSessionFor(
    sessionId,
    { phase: 'recording', startedAt: Date.now(), countdownEndsAt: null, finalizingAt: null },
    (session) => session.phase === 'starting',
  )
  if (!recording) {
    // Stopped or deleted after the host had already started.
    await toHost({ target: started.host, type: 'cancel' } as HostRequest).catch(() => {})
    await closeRecorderTab(started.recorderTabId)
    throw new Error('cancelled')
  }
  await setBadge('REC')
  return recording
}

async function restartRecording(): Promise<void> {
  const { scope } = await readSession()
  await cancelRecording()
  await startRecording(scope)
}

async function stopRecording(): Promise<void> {
  const session = await readSession()
  const { sessionId } = session
  if (!isActive(session) || sessionId === null) return
  // Nothing is captured before the countdown ends, so there is nothing to save.
  if (session.phase === 'starting') return cancelRecording()

  const marked = await writeSessionFor(sessionId, {
    phase: 'finalizing',
    finalizingAt: session.finalizingAt ?? Date.now(),
  })
  if (!marked) return
  await setBadge('···')

  let reply: HostStatus
  try {
    reply = await toActiveHost<HostStatus>('stop')
  } catch (error) {
    // A host reports a failed finalize itself, and the reply is lost when the
    // recorder tab closes first; either way the session has already moved on.
    if (await writeSessionFor(sessionId, { phase: 'error', error: message(error) })) {
      await resetBadge()
      throw error
    }
    return
  }

  // The host had nothing to stop, so no finished or failed report will follow.
  if (reply.sessionId === null && (await endSession(sessionId))) {
    await closeRecorderTab(session.recorderTabId)
  }
}

async function cancelRecording(): Promise<void> {
  const session = await readSession()
  if (!isActive(session)) return
  // Closing the recorder tab mid-save would lose the take.
  if (session.phase === 'finalizing' && (await hostPhase(session.host)) === 'finalizing') return
  await toActiveHost('cancel').catch(() => {})
  if (session.sessionId !== null) await clearSessionFor(session.sessionId)
  await closeRecorderTab(session.recorderTabId)
  await resetBadge()
}

async function toggleRecording(): Promise<void> {
  const session = await readSession()
  try {
    if (isActive(session)) await stopRecording()
    else await startRecording(session.scope)
  } catch (error) {
    if (message(error) === 'cancelled') return
    await writeSession({ phase: 'error', error: message(error) })
    await notify('Butterfly Record', message(error))
    await resetBadge()
  }
}

async function toggleDraw(): Promise<void> {
  const { tabId } = await readSession()
  const target =
    tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id
  if (target === undefined) return
  await chrome.tabs.sendMessage(target, { target: 'overlay', type: 'toggle-draw' }).catch(() => {
    // No overlay on this tab.
  })
}

async function togglePause(): Promise<void> {
  const session = await readSession()
  if (session.phase === 'recording') {
    await toActiveHost('pause')
    await writeSession({ phase: 'paused', pausedAt: Date.now() })
    await setBadge('❚❚')
  } else if (session.phase === 'paused') {
    await toActiveHost('resume')
    const pausedMs = session.pausedMs + (session.pausedAt ? Date.now() - session.pausedAt : 0)
    await writeSession({ phase: 'recording', pausedMs, pausedAt: null })
    await setBadge('REC')
  }
}

async function onTabClosed(tabId: number): Promise<void> {
  const session = await readSession()
  if (!isActive(session)) return

  if (session.tabId === tabId) {
    await stopRecording().catch(() => {})
    return
  }

  if (session.recorderTabId === tabId) {
    // The encoder died with the tab; data already written to OPFS stays recoverable.
    await writeSession({
      phase: 'error',
      recorderTabId: null,
      error: 'The recorder tab was closed, so the recording stopped early.',
    })
    await notify('Recording interrupted', 'The recorder tab was closed before the file was saved.')
    await resetBadge()
  }
}

async function handle(
  request: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (request.type) {
    case 'start-recording':
      return startRecording(request.scope, request.crop)

    case 'stop-recording':
      await stopRecording()
      return readSession()

    case 'cancel-recording':
      await cancelRecording()
      return readSession()

    case 'pause-recording':
    case 'resume-recording':
      await togglePause()
      return readSession()

    case 'get-state': {
      const session = await readSession()
      return { ...session, elapsed: elapsedSeconds(session) }
    }

    case 'request-permissions': {
      await ensureRecorderTab()
      const { recorderTabId } = await readSession()
      if (recorderTabId !== null) await chrome.tabs.update(recorderTabId, { active: true })
      return toHost({ target: 'recorder-tab', type: 'request-permissions' })
    }

    case 'recorder-tab-ready':
      recorderTabReady?.()
      return null

    case 'open-library':
      await chrome.tabs.create({ url: chrome.runtime.getURL('library.html') })
      return null

    case 'list-devices':
      // Needs an extension-origin context; the offscreen document is the cheapest.
      await ensureOffscreen()
      return toHost({ target: 'offscreen', type: 'list-devices' })

    case 'restart-recording':
      await restartRecording()
      return readSession()

    // The device id is read from settings here, so the meter and the recording
    // resolve the same device.
    case 'start-monitor': {
      const { microphoneId } = await loadSettings()
      await ensureOffscreen()
      return toHost({ target: 'offscreen', type: 'start-monitor', microphoneId })
    }

    case 'stop-monitor':
      // No document means no monitor; do not create one just to stop it.
      if (!(await hasOffscreen())) return null
      return toHost({ target: 'offscreen', type: 'stop-monitor' }).catch(() => null)

    case 'levels':
      if (!(await hasOffscreen())) return {}
      return toHost({ target: 'offscreen', type: 'levels' }).catch(() => ({}))

    case 'set-mic-muted': {
      const { host } = await readSession()
      if (host) await toHost({ target: host, type: 'set-mic-muted', muted: request.muted })
      return writeSession({ micMuted: request.muted })
    }

    case 'set-camera-on':
      return writeSession({ cameraOn: request.on })

    case 'capture-ready':
      return writeSessionFor(
        request.sessionId,
        { countdownEndsAt: Date.now() + request.countdownMs },
        (session) => session.phase === 'starting',
      )

    case 'check-folder':
      await ensureOffscreen()
      return toHost({ target: 'offscreen', type: 'check-folder' })

    case 'set-folder-needs-reconnect':
      await writeFolderNeedsReconnect(request.needed)
      return null

    case 'recording-finished':
      await finishRecording(request, recorderTabOf(sender))
      return null

    case 'recording-failed':
      await endSession(request.sessionId)
      await closeRecorderTab(recorderTabOf(sender))
      await notify(
        request.recoverable ? 'Recording kept for recovery' : 'Nothing was recorded',
        request.recoverable
          ? `It couldn’t be finished: ${request.error} Open the library to recover it.`
          : request.error,
      )
      return null

    case 'recording-faulted':
      if (request.fault.recoverable) {
        // The host is saving what it captured; recording-finished or recording-failed follows.
        const saving = await writeSessionFor(
          request.sessionId,
          { phase: 'finalizing', finalizingAt: Date.now() },
          (session) => session.phase === 'recording' || session.phase === 'paused',
        )
        if (saving) await setBadge('···')
      } else {
        await endSession(request.sessionId)
        await closeRecorderTab(recorderTabOf(sender))
      }
      await notify('Recording stopped', request.fault.message)
      return null
  }
}

/** Clears the session if it still belongs to `sessionId`; a newer one is left alone. */
async function endSession(sessionId: string): Promise<boolean> {
  if (!(await clearSessionFor(sessionId))) return false
  await resetBadge()
  return true
}

async function finishRecording(
  request: Extract<BackgroundRequest, { type: 'recording-finished' }>,
  recorderTabId: number | null,
): Promise<void> {
  await endSession(request.sessionId)
  const { destination } = request

  if (destination.kind === 'folder') {
    await closeRecorderTab(recorderTabId)
    await notify('Recording saved', `${destination.name} is in ${destination.folder}.`)
    return
  }

  try {
    await startDownload(destination.blobUrl, destination.filename, {
      host: request.host,
      sessionId: request.sessionId,
      recorderTabId,
    })
  } catch (error) {
    console.error('[butterfly-record] could not start the download', error)
    await closeRecorderTab(recorderTabId)
    await notify('Recording not saved to Downloads', `${message(error)} It is still in your library.`)
    throw error
  }

  if (destination.folderError) {
    await notify(
      'Saved to Downloads instead',
      `Your recordings folder could not be used: ${destination.folderError}`,
    )
  }
}

async function startDownload(
  url: string,
  filename: string,
  pending: PendingDownload,
): Promise<void> {
  // Stored first, so a download that settles at once is still matched.
  const key = `${PENDING_DOWNLOAD_PREFIX}${url}`
  await chrome.storage.session.set({ [key]: pending })
  try {
    await chrome.downloads.download({
      url,
      filename: `Butterfly Record/${filename}`,
      saveAs: false,
      conflictAction: 'uniquify',
    })
  } catch (error) {
    await chrome.storage.session.remove(key)
    throw error
  }
}

/**
 * Revoking the URL or closing the recorder tab before a terminal state truncates
 * the file. The revoke goes to the host because a service worker has no
 * URL.revokeObjectURL.
 */
async function settleDownload(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current
  if (state !== 'complete' && state !== 'interrupted') return

  const [item] = await chrome.downloads.search({ id: delta.id })
  if (!item) return
  const key = `${PENDING_DOWNLOAD_PREFIX}${item.url}`
  const pending = (await chrome.storage.session.get(key))[key] as PendingDownload | undefined
  if (!pending) return
  await chrome.storage.session.remove(key)

  const completed = state === 'complete'
  await toHost({
    target: pending.host,
    type: 'download-settled',
    url: item.url,
    sessionId: pending.sessionId,
    completed,
    filename: completed ? (item.filename.split(/[\\/]/).pop() ?? null) : null,
  } as HostRequest).catch(() => {
    // Host already gone; the blob went with it.
  })
  await closeRecorderTab(pending.recorderTabId)

  if (!completed && item.error !== 'USER_CANCELED') {
    await notify(
      'Recording not saved to Downloads',
      `Chrome stopped the download (${item.error ?? 'unknown reason'}). It is still in your library.`,
    )
  }
}

async function setBadge(text: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: RECORD_COLOUR })
  await chrome.action.setBadgeText({ text })
}

async function resetBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: '' })
}

async function notify(title: string, body: string): Promise<void> {
  if (!chrome.notifications) return
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title,
      message: body,
    })
  } catch {
    /* not granted */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Chrome reports a dismissed picker as NotAllowedError / "Permission denied". */
function isCancellation(error: unknown): boolean {
  const text = message(error)
  return (
    text === 'cancelled' ||
    /NotAllowedError|Permission denied|dismissed by user|canceled|cancelled/i.test(text)
  )
}
