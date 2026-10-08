// Recording state in chrome.storage.session, which survives service worker
// restarts and is cleared when the browser closes.

import type { HostKind, RecordScope, RecordingPhase } from './messages.ts'

const KEY = 'recording-session'

export interface SessionRecord {
  phase: RecordingPhase
  sessionId: string | null
  host: HostKind | null
  scope: RecordScope
  /** The captured tab, or for screen/window scope the tab showing the overlay. */
  tabId: number | null
  recorderTabId: number | null
  /** Tab title, window title, or "Entire screen". */
  sourceLabel: string
  /** Epoch ms when the encoder started; null before that. */
  startedAt: number | null
  /** Epoch ms when Start was pressed. Used only for staleness. */
  requestedAt: number | null
  /** Epoch ms when Stop was pressed. Used only for staleness. */
  finalizingAt: number | null
  pausedMs: number
  /** Epoch ms of the current pause, or null when running. */
  pausedAt: number | null
  /** Epoch ms the countdown ends; null when not counting down. */
  countdownEndsAt: number | null
  micMuted: boolean
  cameraOn: boolean
  error: string | null
}

export const IDLE_SESSION: SessionRecord = {
  phase: 'idle',
  sessionId: null,
  host: null,
  scope: 'tab',
  tabId: null,
  recorderTabId: null,
  sourceLabel: '',
  startedAt: null,
  requestedAt: null,
  finalizingAt: null,
  pausedMs: 0,
  pausedAt: null,
  countdownEndsAt: null,
  micMuted: false,
  cameraOn: false,
  error: null,
}

export async function readSession(): Promise<SessionRecord> {
  const stored = await chrome.storage.session.get(KEY)
  return (stored[KEY] as SessionRecord | undefined) ?? IDLE_SESSION
}

/** Only the worker writes the session; this chain keeps a check and its write together. */
let mutations: Promise<unknown> = Promise.resolve()

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = mutations.then(run, run)
  mutations = next.catch(() => {})
  return next
}

export function writeSession(patch: Partial<SessionRecord>): Promise<SessionRecord> {
  return serialized(async () => {
    const next = { ...(await readSession()), ...patch }
    await chrome.storage.session.set({ [KEY]: next })
    return next
  })
}

/** Patches the session only while it still belongs to `sessionId` and passes `accept`. */
export function writeSessionFor(
  sessionId: string,
  patch: Partial<SessionRecord>,
  accept: (session: SessionRecord) => boolean = isActive,
): Promise<SessionRecord | null> {
  return serialized(async () => {
    const current = await readSession()
    if (current.sessionId !== sessionId || !accept(current)) return null
    const next = { ...current, ...patch }
    await chrome.storage.session.set({ [KEY]: next })
    return next
  })
}

export function clearSession(): Promise<void> {
  return serialized(() => chrome.storage.session.set({ [KEY]: IDLE_SESSION }))
}

/** Clears the session if it still belongs to `sessionId`; false when a newer one is left alone. */
export function clearSessionFor(sessionId: string): Promise<boolean> {
  return serialized(async () => {
    if ((await readSession()).sessionId !== sessionId) return false
    await chrome.storage.session.set({ [KEY]: IDLE_SESSION })
    return true
  })
}

export function onSessionChanged(
  listener: (next: SessionRecord, previous: SessionRecord) => void,
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    const change = changes[KEY]
    if (area !== 'session' || !change) return
    listener(
      (change.newValue as SessionRecord | undefined) ?? IDLE_SESSION,
      (change.oldValue as SessionRecord | undefined) ?? IDLE_SESSION,
    )
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

/** Excludes paused time. */
export function elapsedSeconds(session: SessionRecord, now: number = Date.now()): number {
  if (session.startedAt === null) return 0
  const pausedNow = session.pausedAt === null ? 0 : now - session.pausedAt
  return Math.max(0, (now - session.startedAt - session.pausedMs - pausedNow) / 1000)
}

export function isActive(session: SessionRecord): boolean {
  return (
    session.phase === 'starting' ||
    session.phase === 'recording' ||
    session.phase === 'paused' ||
    session.phase === 'finalizing'
  )
}

/** Generous, because 'starting' includes time spent in Chrome's picker. */
const STALE_AFTER_MS = 5 * 60_000

/** Detects a busy session left behind when the worker was killed mid-start. */
export function isStale(session: SessionRecord, now: number = Date.now()): boolean {
  if (!isActive(session)) return false

  // A busy session with no host was never handed to anyone.
  if (session.host === null && session.phase !== 'starting') return true

  // Measured from requestedAt, because startedAt is null until the encoder starts.
  if (session.phase === 'starting') {
    return session.requestedAt === null || now - session.requestedAt > STALE_AFTER_MS
  }

  if (session.phase === 'finalizing') {
    return session.finalizingAt === null || now - session.finalizingAt > STALE_AFTER_MS
  }

  // 'recording' and 'paused' can last hours; they are verified against the host.
  return false
}
