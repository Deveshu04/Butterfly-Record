// Typed bridge to the Rust commands and events. Binary payloads travel as raw request
// bodies with metadata in headers: a JSON byte array would cost one number per byte.

import type { RecordingManifest } from '@butterfly-record/core'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { CameraAnchor, CameraCorner, CameraShape } from './camera-layout.ts'
import { isIpcError } from './errors.ts'

export { errorMessage, isBlocked, isIpcError, type IpcError } from './errors.ts'

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

export interface LibraryAccess {
  ok: boolean
  root: string
  /** 'blocked': Windows refused writes to a folder that exists, usually Controlled folder access. */
  reason: 'ok' | 'blocked' | 'denied' | 'missing' | 'other'
  /** Why the folder cannot be used; empty when it can. */
  detail: string
  /** The folder lies in one Controlled folder access protects by default. */
  protectedFolder: boolean
  /** That folder's name, e.g. 'Videos'. */
  folderName: string | null
  /** %USERPROFILE%\Butterfly Record, outside the protected folders. */
  homeRoot: string | null
  /** This program, for allowing it in Windows Security. */
  exePath: string | null
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
  /** null = the recording does not use the camera, so the HUD hides its toggle. */
  camera: 'visible' | 'hidden' | null
}

export type HudActionName =
  | 'stop'
  | 'pause'
  | 'resume'
  | 'mute'
  | 'unmute'
  | 'discard'
  | 'camera-show'
  | 'camera-hide'

// Camera overlay window

/** Top-left of the overlay in physical screen pixels. */
export interface CameraPlacement {
  x: number
  y: number
}

export interface CameraOpenOptions {
  /** Logical size. */
  width: number
  height: number
  /** Physical screen pixels; null places the window by `corner`. */
  x: number | null
  y: number | null
  corner: CameraCorner
  /** True in window recordings, where the overlay is a preview and must not be captured. */
  protected: boolean
}

/** What the overlay window needs to show the right camera in the right frame. */
export interface CameraConfig {
  deviceId: string | null
  shape: CameraShape
  mirror: boolean
  /** Hides the hover outline and the resize grip. */
  recording: boolean
}

export interface CameraState {
  status: 'starting' | 'live' | 'error'
  message: string | null
}

export interface HudAction {
  action: HudActionName
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
export const libraryUseHomeRoot = () => call<LibraryInfo>('library_use_home_root')
/** Creates the library folder when missing and writes a test file there. */
export const libraryCheckAccess = () => call<LibraryAccess>('library_check_access')
/** Windows Security's ransomware protection page. */
export const openWindowsSecurity = () => call<void>('open_windows_security')
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

// Camera overlay window

export const cameraOpen = (options: CameraOpenOptions) =>
  call<CameraPlacement>('camera_open', options as unknown as Record<string, unknown>)
export const cameraClose = () => call<void>('camera_close')
export const cameraSetVisible = (visible: boolean) =>
  call<void>('camera_set_visible', { visible })
/** Logical size, keeping the top-left where it is. */
export const cameraSetSize = (width: number, height: number) =>
  call<void>('camera_set_size', { width, height })
export const cameraSetProtected = (isProtected: boolean) =>
  call<void>('camera_set_protected', { protected: isProtected })
export const cameraResetPosition = (corner: CameraCorner) =>
  call<CameraPlacement>('camera_reset_position', { corner })
/** Where the overlay sits on its monitor, as fractions; null when it is closed or off-screen. */
export const cameraAnchor = () => call<CameraAnchor | null>('camera_anchor')

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

export const emitCameraConfig = (config: CameraConfig) =>
  emitTo('camera', 'camera-config', config)

export const onCameraConfig = (handler: (config: CameraConfig) => void): Promise<UnlistenFn> =>
  listen<CameraConfig>('camera-config', (event) => handler(event.payload))

export const emitCameraState = (state: CameraState) => emitTo('main', 'camera-state', state)

export const onCameraState = (handler: (state: CameraState) => void): Promise<UnlistenFn> =>
  listen<CameraState>('camera-state', (event) => handler(event.payload))
