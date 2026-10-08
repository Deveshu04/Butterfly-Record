// Typed bridge to the Rust commands and events. Binary payloads travel as raw request
// bodies with metadata in headers: a JSON byte array would cost one number per byte.

import type { RecordingManifest } from '@butterfly-record/core'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface IpcError {
  code: string
  message: string
  status?: number
  requestId?: string
}

export interface DesktopOutput {
  kind: 'dub' | 'captions'
  /** Canonical app code, e.g. 'hi-IN'. */
  language: string
  /** Relative to the library root when inside it, else absolute. */
  path: string
  method: 'sarvam-dubbing' | 'tts' | 'export'
  createdAt: string
}

export interface DesktopManifest extends RecordingManifest {
  /** null while recording and before finalize. */
  media: { path: string; external: boolean } | null
  outputs: DesktopOutput[]
}

export interface LibraryInfo {
  root: string
  defaultRoot: string
  freeBytes: number
}

export interface LibraryItem {
  id: string
  /** null when unreadable. */
  manifest: DesktopManifest | null
  /** Absolute; null if there is no media or the file is missing. */
  mediaPath: string | null
  mediaBytes: number | null
  /** Size of source.part when present. */
  partBytes: number | null
  /** File names in the session directory. */
  sidecar: string[]
  sessionDir: string
}

export type ReadTarget =
  | { kind: 'part'; id: string }
  | { kind: 'media'; id: string }
  | { kind: 'sidecar'; id: string; name: string }
  | { kind: 'path'; path: string }

export type WriteTarget =
  | { kind: 'media'; id: string; baseName: string; ext: string }
  | { kind: 'output'; id: string; baseName: string; ext: string }
  | { kind: 'sidecar'; id: string; name: string }
  | { kind: 'path'; path: string }

export interface OpenedFile {
  handle: number
  size: number
  path: string
}

export interface CommitResult {
  path: string
  /** Relative to the library root, or null outside it. */
  relPath: string | null
  bytes: number
}

export type RecorderPhase =
  'idle' | 'starting' | 'countdown' | 'recording' | 'paused' | 'finalizing'

export type SttModel = 'saaras:v4' | 'saaras:v3'
export type SttMode = 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix'
export type TranslateModel = 'sarvam-translate:v1' | 'mayura:v1'

export interface SttRequest {
  task: string
  id: string
  /** Sidecar names of the extracted audio parts, each at most two hours. */
  files: string[]
  /** Start of each part on the source timeline, in seconds. */
  offsets: number[]
  duration: number
  /** 'unknown' = auto-detect. */
  language: string
  model: SttModel
  mode: SttMode
  diarize: boolean
  numSpeakers: number | null
  resumeJobId?: string | null
}

export interface SttResult {
  language: string | null
  segments: { start: number; end: number; text: string; speaker: string | null }[]
  requestIds: string[]
}

export interface TranslateRequest {
  task: string
  texts: string[]
  source: string
  target: string
  model: TranslateModel
}

export interface TtsRequest {
  text: string
  language: string
  speaker: string
  pace: number
  sampleRate: number
}

export type DubExport = 'video' | 'audio' | 'srt'

export interface DubRequest {
  task: string
  id: string
  upload: ReadTarget
  sourceLanguage: string
  targetLanguages: string[]
  /** 1..10, or -1 to auto-detect. */
  numSpeakers: number
  exports: DubExport[]
  resumeJobId?: string | null
}

export interface DubResult {
  jobId: string
  outputs: {
    language: string
    type: 'video' | 'audio' | 'mp3' | 'srt'
    sidecarName: string
    bytes: number
  }[]
  failed: { language: string; message: string }[]
}

export type PendingJob =
  | { id: string; kind: 'stt'; jobId: string; createdAt: string; request: SttRequest }
  | { id: string; kind: 'dub'; jobId: string; createdAt: string; request: DubRequest }

export interface SarvamProgress {
  task: string
  stage: string
  fraction: number | null
  message: string
}

export interface RecorderStatus {
  phase: RecorderPhase
  elapsed: number
  micMuted: boolean
  hasMic: boolean
  countdown: number | null
}

export type HudActionName = 'stop' | 'pause' | 'resume' | 'mute' | 'unmute' | 'discard'

export interface HudAction {
  action: HudActionName
}

export function isIpcError(e: unknown): e is IpcError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as IpcError).code === 'string' &&
    typeof (e as IpcError).message === 'string'
  )
}

const FRIENDLY: Record<string, string> = {
  not_found: 'The file could not be found. It may have been moved or deleted.',
  disk_full: 'The disk is full. Free up some space and try again.',
  forbidden: 'Butterfly Record is not allowed to use that location.',
  no_key: 'Add your Sarvam API key in Settings first.',
  invalid_key: 'Sarvam rejected the API key. Check it in Settings.',
  quota: 'Your Sarvam credits have run out. Top up at dashboard.sarvam.ai and try again.',
  rate_limited: 'Sarvam is receiving too many requests right now. Wait a minute and try again.',
  too_large: 'This file is larger or longer than Sarvam accepts on your plan.',
  network: 'Could not reach Sarvam. Check your internet connection and try again.',
  cancelled: 'Cancelled.',
}

/** A user-facing sentence for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isIpcError(e)) {
    const friendly = FRIENDLY[e.code]
    if (friendly) return friendly
    const detail = e.message.trim()
    switch (e.code) {
      case 'invalid_argument':
        return detail || 'The request was not valid.'
      case 'io':
        return detail ? `A file operation failed: ${detail}` : 'A file operation failed.'
      case 'unsupported':
        return detail || 'Sarvam does not support this language or file.'
      case 'api': {
        const reference = e.requestId ? ` (request ${e.requestId})` : ''
        return detail
          ? `Sarvam returned an error: ${detail}${reference}`
          : `Sarvam returned an error${reference}.`
      }
      default:
        return detail || 'Something went wrong.'
    }
  }
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError') return 'Permission was denied.'
    if (e.name === 'NotFoundError') return 'The requested device was not found.'
    if (e.name === 'NotReadableError') return 'The device is in use by another application.'
    if (e.name === 'AbortError') return 'Cancelled.'
  }
  if (e instanceof Error) return e.message || 'Something went wrong.'
  if (typeof e === 'string' && e.trim()) return e
  return 'Something went wrong.'
}

/** Rust rejects with IpcError objects; anything else (a bare string) becomes an Error. */
async function call<T>(
  cmd: string,
  args?: Parameters<typeof invoke>[1],
  options?: Parameters<typeof invoke>[2],
): Promise<T> {
  try {
    return await invoke<T>(cmd, args, options)
  } catch (error) {
    if (isIpcError(error) || error instanceof Error) throw error
    throw new Error(typeof error === 'string' ? error : `${cmd} failed`)
  }
}

// Library

export const libraryInfo = () => call<LibraryInfo>('library_info')
export const librarySetRoot = (path: string) => call<LibraryInfo>('library_set_root', { path })
export const libraryList = () => call<LibraryItem[]>('library_list')
export const sessionCreate = (id: string) => call<string>('session_create', { id })
export const libraryTrash = (id: string) => call<void>('library_trash', { id })
export const sessionDiscard = (id: string) => call<void>('session_discard', { id })
export const mediaRename = (id: string, baseName: string) =>
  call<string>('media_rename', { id, baseName })
export const revealPath = (path: string) => call<void>('reveal_path', { path })
export const openPath = (path: string) => call<void>('open_path', { path })
export const pickFolder = () => call<string | null>('pick_folder')
export const pickImportFiles = () => call<string[]>('pick_import_files')
export const pickSavePath = (defaultName: string, extensions: string[]) =>
  call<string | null>('pick_save_path', { defaultName, extensions })

// Session sidecar files

export const sidecarReadText = (id: string, name: string) =>
  call<string | null>('sidecar_read_text', { id, name })
export const sidecarWriteText = (id: string, name: string, text: string) =>
  call<void>('sidecar_write_text', { id, name, text })
export const sidecarWriteBytes = (id: string, name: string, bytes: Uint8Array) =>
  call<void>('sidecar_write_bytes', bytes, { headers: { 'x-id': id, 'x-name': name } })
export const sidecarRemove = (id: string, name: string) =>
  call<void>('sidecar_remove', { id, name })

// Recording sink

export const recOpen = (id: string) => call<void>('rec_open', { id })
export const recWrite = (id: string, bytes: Uint8Array) =>
  call<number>('rec_write', bytes, { headers: { 'x-id': id } })
export const recFlush = (id: string) => call<void>('rec_flush', { id })
export const recClose = (id: string) => call<number>('rec_close', { id })
export const recAbort = (id: string) => call<void>('rec_abort', { id })

// Random-access file I/O

export const fsOpen = (target: ReadTarget) => call<OpenedFile>('fs_open', { target })
export const fsRead = (handle: number, offset: number, length: number) =>
  call<ArrayBuffer>('fs_read', { handle, offset, length })
export const fsClose = (handle: number) => call<void>('fs_close', { handle })
export const fsCreate = (target: WriteTarget) => call<{ handle: number }>('fs_create', { target })
export const fsWrite = (handle: number, position: number, bytes: Uint8Array) =>
  call<void>('fs_write', bytes, {
    headers: { 'x-handle': String(handle), 'x-position': String(position) },
  })
export const fsCommit = (handle: number) => call<CommitResult>('fs_commit', { handle })
export const fsDiscard = (handle: number) => call<void>('fs_discard', { handle })
export const fsUncommit = (id: string, path: string) => call<void>('fs_uncommit', { id, path })

// Settings and app

export const settingsGet = () => call<Record<string, unknown>>('settings_get')
export const settingsSet = (value: object) => call<void>('settings_set', { value })
export const recorderSetState = (state: RecorderPhase) =>
  call<void>('recorder_set_state', { state })
export const hudOpen = () => call<void>('hud_open')
export const hudClose = () => call<void>('hud_close')
export const appQuit = () => call<void>('app_quit')

// Sarvam (struct arguments travel under a single `request` key)

export const sarvamKeyStatus = () => call<{ present: boolean }>('sarvam_key_status')
export const sarvamKeySet = (key: string) => call<void>('sarvam_key_set', { key })
export const sarvamKeyClear = () => call<void>('sarvam_key_clear')
export const sarvamKeyTest = () => call<{ ok: boolean; message: string }>('sarvam_key_test')
export const sarvamTranscribe = (request: SttRequest) =>
  call<SttResult>('sarvam_transcribe', { request })
export const sarvamTranslate = (request: TranslateRequest) =>
  call<string[]>('sarvam_translate', { request })
export const sarvamTts = (request: TtsRequest) => call<ArrayBuffer>('sarvam_tts', { request })
export const sarvamDub = (request: DubRequest) => call<DubResult>('sarvam_dub', { request })
export const sarvamSummarize = (text: string, language: string | null) =>
  call<{ title: string; summary: string }>('sarvam_summarize', { text, language })
export const sarvamCancel = (task: string) => call<void>('sarvam_cancel', { task })
export const sarvamPendingJobs = () => call<PendingJob[]>('sarvam_pending_jobs')

// Events

export const onRecordToggle = (handler: () => void): Promise<UnlistenFn> =>
  listen('record-toggle', () => handler())

export const onQuitRequested = (handler: () => void): Promise<UnlistenFn> =>
  listen('quit-requested', () => handler())

export const onSarvamProgress = (
  handler: (progress: SarvamProgress) => void,
): Promise<UnlistenFn> =>
  listen<SarvamProgress>('sarvam-progress', (event) => handler(event.payload))

export const onRecorderStatus = (handler: (status: RecorderStatus) => void): Promise<UnlistenFn> =>
  listen<RecorderStatus>('recorder-status', (event) => handler(event.payload))

export const onHudAction = (handler: (action: HudActionName) => void): Promise<UnlistenFn> =>
  listen<HudAction>('hud-action', (event) => handler(event.payload.action))

export const emitRecorderStatus = (status: RecorderStatus) =>
  emitTo('hud', 'recorder-status', status)

export const emitHudAction = (action: HudActionName) =>
  emitTo('main', 'hud-action', { action } satisfies HudAction)
