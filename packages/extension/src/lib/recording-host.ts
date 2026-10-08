// Shared by both hosts: the offscreen document and the pinned recorder tab, which
// exists because a desktopCapture stream ID throws "Invalid state" offscreen.

import {
  AudioMixer,
  MediaRecorderEncoder,
  audioBitrateFor,
  bitrateFor,
  composeRecordingStream,
  createManifest,
  MANIFEST_FILE,
  pickRecordingCodec,
  readSource,
  removeSession,
  requestPersistence,
  safeFilenameWithExtension,
  sessionPath,
  updateManifest,
  writeJson,
  type AudioTrackKind,
  type CaptureSurface,
  type EncoderFault,
  type FinalizedFields,
  type MixerInput,
} from '@butterfly-record/core'

import {
  HOST_BUSY,
  type BackgroundRequest,
  type DownloadSettled,
  type HostKind,
  type HostStatus,
  type RecordingPhase,
  type Reply,
} from './messages.ts'
import { copyToGrantedFolder, forgetSaved, readSaved, writeSaved } from './recordings-folder.ts'

export interface BeginRequest {
  sessionId: string
  surface: CaptureSurface
  /** Shown in the library. */
  sourceLabel: string
  captureStream: MediaStream
  micStream: MediaStream | null
  /** Applied after acquiring the stream: a tabCapture stream ID expires within seconds. */
  countdownMs: number
  /** Where the worker sends download-settled. */
  host: HostKind
}

interface Active {
  sessionId: string
  host: HostKind
  encoder: MediaRecorderEncoder
  mixer: AudioMixer | null
  captureStream: MediaStream
  micStream: MediaStream | null
}

/** From capture until the encoder runs; Stop or Cancel in that window aborts the start. */
interface PendingStart {
  aborted: boolean
  /** Ends the countdown early. */
  wake: () => void
  settled: Promise<void>
}

let active: Active | null = null
let pending: PendingStart | null = null
let phase: RecordingPhase = 'idle'
/** The last saved.json write, which download-settled must not overtake. */
let bookkeeping: Promise<void> = Promise.resolve()

/** Tab capture mutes the tab, so its audio is monitored; desktop audio would play twice. */
function captureAudioRole(surface: CaptureSurface): { kind: AudioTrackKind; monitor: boolean } {
  return surface === 'tab' ? { kind: 'tab', monitor: true } : { kind: 'system', monitor: false }
}

export async function tryMicrophone(microphoneId: string | null = null): Promise<MediaStream | null> {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  // `ideal`, not `exact`, so an unplugged device falls back to the default mic.
  if (microphoneId) audio.deviceId = { ideal: microphoneId }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio })
  } catch {
    return null
  }
}

/** Checked before opening a picker, so a second Start never captures anything. */
export function assertIdle(): void {
  // `active` is only set once the encoder runs, so 'starting' covers the countdown.
  if (active || phase === 'starting') throw new Error(HOST_BUSY)
}

export async function beginRecording(request: BeginRequest): Promise<HostStatus> {
  if (active || phase === 'starting') {
    stopStreams(request)
    throw new Error(HOST_BUSY)
  }
  phase = 'starting'

  let finished!: () => void
  const start: PendingStart = {
    aborted: false,
    wake: () => {},
    settled: new Promise((resolve) => (finished = resolve)),
  }
  pending = start
  const checkAborted = () => {
    if (start.aborted) throw new Error('cancelled')
  }

  let mixer: AudioMixer | null = null
  let encoder: MediaRecorderEncoder | null = null
  try {
    await requestPersistence()

    const [videoTrack] = request.captureStream.getVideoTracks()
    if (!videoTrack) throw new Error('The capture produced no video track.')

    const inputs: MixerInput[] = []
    if (request.captureStream.getAudioTracks().length > 0) {
      const role = captureAudioRole(request.surface)
      inputs.push({
        kind: role.kind,
        label: request.sourceLabel,
        stream: request.captureStream,
        monitor: role.monitor,
      })
    }
    if (request.micStream) {
      inputs.push({
        kind: 'mic',
        label: request.micStream.getAudioTracks()[0]?.label ?? 'Microphone',
        stream: request.micStream,
        monitor: false,
      })
    }

    mixer = inputs.length > 0 ? await AudioMixer.create(inputs, { meters: true }) : null
    checkAborted()

    const settings = videoTrack.getSettings()
    const width = settings.width ?? 1920
    const height = settings.height ?? 1080
    const frameRate = Math.round(settings.frameRate ?? 30)

    const codec = pickRecordingCodec()
    const videoBitsPerSecond = bitrateFor({ width, height, frameRate })
    const audioBitsPerSecond = audioBitrateFor(2)

    const manifest = createManifest({
      id: request.sessionId,
      producer: {
        app: 'extension',
        version: __APP_VERSION__,
        os: navigator.userAgent,
      },
      video: {
        codec: codec.videoCodec,
        container: 'webm',
        width,
        height,
        frameRate,
        bitrate: videoBitsPerSecond,
        surface: request.surface,
        sourceLabel: request.sourceLabel,
      },
      audio: {
        codec: 'opus',
        sampleRate: 48000,
        channels: 2,
        tracks: mixer ? mixer.contributions() : [],
      },
      camera: null,
    })
    await writeJson(sessionPath(request.sessionId, MANIFEST_FILE), manifest)

    // The stream is live, so the countdown cannot overlap Chrome's picker.
    if (request.countdownMs > 0) {
      checkAborted()
      await notifyBackground({
        target: 'background',
        type: 'capture-ready',
        sessionId: request.sessionId,
        countdownMs: request.countdownMs,
      })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, request.countdownMs)
        start.wake = () => {
          clearTimeout(timer)
          resolve()
        }
        if (start.aborted) start.wake()
      })
    }
    checkAborted()

    encoder = new MediaRecorderEncoder()
    await encoder.start({
      sessionId: request.sessionId,
      stream: composeRecordingStream(videoTrack, mixer?.track ?? null),
      width,
      height,
      frameRate,
      surface: request.surface,
      videoBitsPerSecond,
      audioBitsPerSecond,
      onFault: (fault) => void onFault(request.sessionId, fault),
    })
    checkAborted()

    active = {
      sessionId: request.sessionId,
      host: request.host,
      encoder,
      mixer,
      captureStream: request.captureStream,
      micStream: request.micStream,
    }
    phase = 'recording'
    return status()
  } catch (error) {
    await encoder?.cancel().catch(() => {})
    await mixer?.close().catch(() => {})
    stopStreams(request)
    // Nothing was recorded, so leave no session folder behind.
    await removeSession(request.sessionId).catch(() => {})
    phase = 'idle'
    throw error
  } finally {
    pending = null
    finished()
  }
}

function stopStreams(request: BeginRequest): void {
  for (const track of request.captureStream.getTracks()) track.stop()
  for (const track of request.micStream?.getTracks() ?? []) track.stop()
}

/** True when a start was still counting down; it then rejects with 'cancelled'. */
async function abortPendingStart(): Promise<boolean> {
  const start = pending
  if (active || !start) return false
  start.aborted = true
  start.wake()
  await start.settled
  return true
}

/** Recoverable faults keep the bytes written so far, so they are finalized. */
async function onFault(sessionId: string, fault: EncoderFault): Promise<void> {
  if (fault.recoverable) {
    void notifyBackground({ target: 'background', type: 'recording-faulted', sessionId, fault })
    await stopRecording().catch(() => {})
    return
  }
  // Released first, so the worker can close the recorder tab once it hears of it.
  await cancelRecording().catch(() => {})
  await notifyBackground({ target: 'background', type: 'recording-faulted', sessionId, fault })
}

async function releaseHardware(recording: Active): Promise<void> {
  try {
    await recording.mixer?.close()
  } finally {
    for (const track of recording.captureStream.getTracks()) track.stop()
    for (const track of recording.micStream?.getTracks() ?? []) track.stop()
  }
}

/** Stops capture and finalizes; the devices are released whatever happens. */
async function finishCapture(recording: Active): Promise<FinalizedFields> {
  try {
    return await recording.encoder.stop()
  } finally {
    await releaseHardware(recording).catch((error) => {
      console.warn('[butterfly-record] could not release the capture devices', error)
    })
  }
}

/**
 * Finalizes, then saves to the recordings folder or hands a blob URL to the worker
 * for Downloads. A failed finalize keeps the capture in OPFS for recovery. The host
 * is free for the next recording either way.
 */
export async function stopRecording(): Promise<HostStatus> {
  // Nothing has been captured during the countdown, so Stop discards the start.
  if (await abortPendingStart()) return status()
  const recording = active
  if (!recording || phase === 'finalizing') return status()
  phase = 'finalizing'

  try {
    const finalized = await finishCapture(recording).catch(async (error: unknown) => {
      await keepForRecovery(recording.sessionId, error, recording.encoder.bytesWritten > 0)
      throw error
    })

    let title = 'Recording'
    try {
      const manifest = await updateManifest(recording.sessionId, {
        ...finalized,
        status: 'ready',
        pauses: [...recording.encoder.pauses],
      })
      if (manifest) title = manifest.title
    } catch (error) {
      // The finished file is intact; only its library details are stale.
      console.warn('[butterfly-record] could not update the manifest', error)
    }

    await deliver(recording, title)
  } finally {
    active = null
    phase = 'idle'
  }
  return status()
}

async function keepForRecovery(
  sessionId: string,
  error: unknown,
  recoverable: boolean,
): Promise<void> {
  console.error('[butterfly-record] could not finish the recording', error)
  await updateManifest(sessionId, { status: 'orphaned' }).catch((cause: unknown) => {
    console.warn('[butterfly-record] could not mark the recording for recovery', cause)
  })
  await notifyBackground({
    target: 'background',
    type: 'recording-failed',
    sessionId,
    error: errorText(error),
    recoverable,
  })
}

/** The recording is already in the library here, so nothing in this throws. */
async function deliver(recording: Active, title: string): Promise<void> {
  const { sessionId, host } = recording

  let folderError: string | null = null
  try {
    const saved = await copyToGrantedFolder(sessionId, title)
    if (saved.status === 'saved') {
      await notifyBackground({
        target: 'background',
        type: 'recording-finished',
        sessionId,
        destination: { kind: 'folder', folder: saved.folder, name: saved.record.name },
        host,
      })
      return
    }
    if (saved.status === 'needs-permission') {
      folderError = `Chrome needs permission to use “${saved.folder}” again. Open the library and click Reconnect.`
    }
  } catch (error) {
    console.warn('[butterfly-record] could not save to the recordings folder', error)
    folderError = errorText(error)
  }

  let blobUrl: string
  try {
    // The OPFS File is lazily backed, so a blob URL over it does not load the
    // recording into memory.
    blobUrl = URL.createObjectURL(await readSource(sessionId))
  } catch (error) {
    console.error('[butterfly-record] could not read the finished recording', error)
    await notifyBackground({
      target: 'background',
      type: 'recording-failed',
      sessionId,
      error: errorText(error),
      recoverable: true,
    })
    return
  }

  const filename = safeFilenameWithExtension(title, 'webm')
  const reply = await notifyBackground({
    target: 'background',
    type: 'recording-finished',
    sessionId,
    destination: { kind: 'downloads', blobUrl, filename, folderError },
    host,
  })
  if (!reply?.ok) {
    URL.revokeObjectURL(blobUrl)
    return
  }

  // Not awaited, so the host is free as soon as the worker has the download.
  bookkeeping = writeSaved(sessionId, 'downloads', filename).then(
    () => {},
    (error: unknown) => console.warn('[butterfly-record] could not record the download', error),
  )
}

/** Revokes a download's blob URL and corrects saved.json to what actually landed. */
export async function downloadSettled(settled: DownloadSettled): Promise<null> {
  await bookkeeping
  URL.revokeObjectURL(settled.url)

  try {
    const saved = await readSaved(settled.sessionId)
    if (saved?.kind !== 'downloads') return null
    if (!settled.completed) await forgetSaved(settled.sessionId)
    else if (settled.filename && settled.filename !== saved.name) {
      await writeSaved(settled.sessionId, 'downloads', settled.filename)
    }
  } catch (error) {
    console.warn('[butterfly-record] could not update saved.json', error)
  }
  return null
}

export async function cancelRecording(): Promise<HostStatus> {
  if (await abortPendingStart()) return status()
  const recording = active
  // Cancelling mid-finalize would delete the part file the remux is reading.
  if (!recording || phase === 'finalizing') return status()
  try {
    await recording.encoder.cancel()
  } finally {
    await releaseHardware(recording).catch(() => {})
    active = null
    phase = 'idle'
  }
  return status()
}

/** Gain, not `track.enabled`: Chrome records a disabled track as silence but Web Audio drops it. */
export function setSourceMuted(kind: AudioTrackKind, muted: boolean): HostStatus {
  active?.mixer?.setGain(kind, muted ? 0 : 1)
  return status()
}

/** Peak level per source. */
export function levels(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [kind, level] of active?.mixer?.levels() ?? []) out[kind] = level
  return out
}

export function pauseRecording(): HostStatus {
  if (active && phase === 'recording') {
    active.encoder.pause()
    phase = 'paused'
  }
  return status()
}

export function resumeRecording(): HostStatus {
  if (active && phase === 'paused') {
    active.encoder.resume()
    phase = 'recording'
  }
  return status()
}

export function status(): HostStatus {
  return {
    phase,
    sessionId: active?.sessionId ?? null,
    elapsed: active?.encoder.elapsed ?? 0,
    bytesWritten: active?.encoder.bytesWritten ?? 0,
  }
}

export function isRecording(): boolean {
  return active !== null
}

/** After a failed start; never overrides a recording that is still running. */
export function markFailed(error: unknown): void {
  if (errorText(error) === 'cancelled') return
  if (!active && phase === 'idle') phase = 'error'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Undefined when the worker could not be reached. */
function notifyBackground(message: BackgroundRequest): Promise<Reply<unknown> | undefined> {
  return chrome.runtime.sendMessage<BackgroundRequest, Reply<unknown>>(message).catch(() => {
    // The worker may be restarting; durable state is in storage.session.
    return undefined
  })
}
