// Shared on-disk format: the extension and the desktop app must both write it exactly.

// Older schemas are upgraded on read by `normalizeManifest`.
export const MANIFEST_SCHEMA = 2

export type RecordingStatus =
  /** A crash leaves the manifest in this state. */
  | 'recording'
  | 'finalizing'
  | 'ready'
  /** Found at startup with no live writer. */
  | 'orphaned'

export type CaptureSurface = 'tab' | 'display' | 'window' | 'region' | 'camera'

export type VideoCodecName = 'vp9' | 'vp8' | 'av1' | 'h264'
export type AudioCodecName = 'opus' | 'aac'
export type ContainerName = 'webm' | 'mp4'

export type AudioTrackKind = 'mic' | 'tab' | 'system' | 'process'

export interface AudioContribution {
  kind: AudioTrackKind
  label: string
  /** Gain at record time; 0 means muted. */
  gain: number
}

/** Source-timeline seconds. */
export interface PauseSpan {
  at: number
  resumedAt: number
}

export interface RecordingManifest {
  /** ULID; also the share slug. */
  id: string
  schema: typeof MANIFEST_SCHEMA
  createdAt: string
  producer: {
    /** `import` marks a file brought in rather than recorded. */
    app: 'extension' | 'desktop' | 'import'
    version: string
    os: string
  }
  status: RecordingStatus
  /** ISO 8601 time the recording was trashed; null while live. */
  deletedAt: string | null
  /** Seconds. Null while still recording. */
  duration: number | null
  video: {
    codec: VideoCodecName
    container: ContainerName
    width: number
    height: number
    frameRate: number
    /** Requested bits/sec; Chrome's actual rate lands within ~10-15%. */
    bitrate: number
    surface: CaptureSurface
    sourceLabel: string
  }
  audio: {
    codec: AudioCodecName
    sampleRate: 48000
    channels: 1 | 2
    tracks: AudioContribution[]
  }
  camera: {
    present: boolean
    /** overlay = bubble captured with the screen; composited = drawn into the frames. */
    mode: 'overlay' | 'composited' | 'only'
    shape: 'circle' | 'rounded' | 'wide' | 'tall'
    mirrored: boolean
  } | null
  pauses: PauseSpan[]
  bytes: number
  sha256: string | null
  title: string
  /** Chapters are parsed out of this. */
  description: string
  folderId: string | null
  /** Source-timeline seconds of a custom thumbnail; null lets `generatePoster` choose. */
  posterTime: number | null
  share: {
    destination: 'none' | 'server' | 'bucket'
    url: string | null
    uploadedBytes: number
    password: boolean
    expiresAt: string | null
  } | null
}

export type FinalizedFields = Pick<RecordingManifest, 'duration' | 'bytes' | 'sha256'>

export interface NewRecordingInit {
  id: string
  producer: RecordingManifest['producer']
  video: RecordingManifest['video']
  audio: RecordingManifest['audio']
  camera: RecordingManifest['camera']
  title?: string
}

export function createManifest(init: NewRecordingInit): RecordingManifest {
  return {
    id: init.id,
    schema: MANIFEST_SCHEMA,
    createdAt: new Date().toISOString(),
    producer: init.producer,
    status: 'recording',
    deletedAt: null,
    duration: null,
    video: init.video,
    audio: init.audio,
    camera: init.camera,
    pauses: [],
    bytes: 0,
    sha256: null,
    title: init.title ?? defaultTitle(new Date()),
    description: '',
    folderId: null,
    posterTime: null,
    share: null,
  }
}

/**
 * Defaults fields missing from older schemas. Every read must go through here:
 * a missing `deletedAt` is undefined, which breaks `=== null` trash checks.
 */
export function normalizeManifest(raw: RecordingManifest): RecordingManifest {
  const loose = raw as Partial<RecordingManifest>
  return {
    ...raw,
    schema: MANIFEST_SCHEMA,
    deletedAt: loose.deletedAt ?? null,
    posterTime: loose.posterTime ?? null,
    folderId: loose.folderId ?? null,
    description: loose.description ?? '',
    pauses: loose.pauses ?? [],
    share: loose.share ?? null,
  }
}

export function isTrashed(manifest: RecordingManifest): boolean {
  return manifest.deletedAt !== null
}

/** e.g. "Recording 2 Aug 2026, 10:45". */
export function defaultTitle(at: Date): string {
  const date = at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `Recording ${date}, ${time}`
}
