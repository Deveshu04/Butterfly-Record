import { fullEdl, isUnedited, normalize, type Edl } from './edl.ts'
import { isUlid, ulidTime } from './ids.ts'
import {
  DEV_REPORT_FILE,
  EDL_FILE,
  MANIFEST_FILE,
  PART_FILE,
  PEAKS_FILE,
  POSTER_FILE,
  PREVIEW_FILE,
  SOURCE_FILE,
  fileHandle,
  isNotFound,
  listSessionIds,
  readJson,
  removeFile,
  removeSession,
  sessionPath,
  TRANSCRIPT_FILE,
  writeFile,
  writeJson,
} from './opfs.ts'
import { normalizeManifest, type RecordingManifest } from './manifest.ts'
import type { Transcript } from './transcript.ts'

export interface LibraryEntry {
  manifest: RecordingManifest
  /** Size of source.webm, or of the part file for an interrupted recording. */
  bytes: number
  /** True when the part file still has to be finalized. */
  needsRecovery: boolean
}

export interface ListOptions {
  /** Defaults to `'live'`, which hides trashed recordings. */
  include?: 'live' | 'trashed' | 'all'
}

/** Sizes of a session's media files; null when the file does not exist. */
export interface SessionMedia {
  source: number | null
  part: number | null
}

export type SessionState = 'ready' | 'recoverable' | 'empty'

/**
 * A source.webm must not hide the capture next to it when it is empty, or when the manifest
 * never reached 'ready': earlier builds left a truncated one after a failed finalize.
 */
export function sessionState(
  media: SessionMedia,
  status?: RecordingManifest['status'],
): SessionState {
  const hasSource = media.source !== null && media.source > 0
  const hasPart = media.part !== null && media.part > 0
  if (hasPart && (!hasSource || (status !== undefined && status !== 'ready'))) {
    return 'recoverable'
  }
  return hasSource ? 'ready' : 'empty'
}

/** Old enough that a session with no media cannot still be starting a recording. */
export const ABANDONED_SESSION_AGE_MS = 24 * 60 * 60 * 1000

export function isAbandonedSession(
  id: string,
  media: SessionMedia,
  now: number = Date.now(),
): boolean {
  return (
    sessionState(media) === 'empty' && isUlid(id) && now - ulidTime(id) > ABANDONED_SESSION_AGE_MS
  )
}

/** Thrown before a remux that would run out of space; the raw capture is kept for recovery. */
export class InsufficientSpaceError extends Error {
  override readonly name = 'InsufficientSpaceError'
  readonly required: number
  readonly available: number

  constructor(required: number, available: number) {
    super(
      `Not enough free space to finish this recording: about ${formatBytes(required)} is needed and ${formatBytes(available)} is free. ` +
        'The recording was kept. Free up space, then recover it from the library.',
    )
    this.required = required
    this.available = available
  }
}

/**
 * Newest first. A session that cannot be read is skipped rather than failing the list, and
 * one left with no media at all is deleted once it is old enough.
 */
export async function listRecordings(options: ListOptions = {}): Promise<LibraryEntry[]> {
  const include = options.include ?? 'live'
  const now = Date.now()
  const ids = await listSessionIds()
  const entries = await Promise.all(ids.map((id) => listedEntry(id, now)))
  return entries.filter((entry): entry is LibraryEntry => {
    if (entry === null) return false
    if (include === 'all') return true
    const trashed = entry.manifest.deletedAt !== null
    return include === 'trashed' ? trashed : !trashed
  })
}

export async function listTrash(): Promise<LibraryEntry[]> {
  const entries = await listRecordings({ include: 'trashed' })
  return entries.sort((a, b) => (b.manifest.deletedAt ?? '').localeCompare(a.manifest.deletedAt ?? ''))
}

export async function readEntry(id: string): Promise<LibraryEntry | null> {
  return entryFor(id, await sessionMedia(id))
}

async function listedEntry(id: string, now: number): Promise<LibraryEntry | null> {
  try {
    const media = await sessionMedia(id)
    if (isAbandonedSession(id, media, now)) {
      await removeSession(id)
      return null
    }
    return await entryFor(id, media)
  } catch (error) {
    console.warn(`[butterfly-record] skipped unreadable session ${id}`, error)
    return null
  }
}

async function entryFor(id: string, media: SessionMedia): Promise<LibraryEntry | null> {
  // Failed before its first chunk: nothing to show or recover.
  if (sessionState(media) === 'empty') return null

  const stored = await readJson<RecordingManifest>(sessionPath(id, MANIFEST_FILE))
  if (!stored) return null
  const manifest = normalizeManifest(stored)

  if (sessionState(media, manifest.status) === 'ready') {
    return { manifest, bytes: media.source ?? 0, needsRecovery: false }
  }
  return {
    manifest: { ...manifest, status: 'orphaned' },
    bytes: media.part ?? 0,
    needsRecovery: true,
  }
}

async function sessionMedia(id: string): Promise<SessionMedia> {
  const [source, part] = await Promise.all([
    sizeOf(sessionPath(id, SOURCE_FILE)),
    sizeOf(sessionPath(id, PART_FILE)),
  ])
  return { source, part }
}

async function sizeOf(path: string[]): Promise<number | null> {
  try {
    const file = await (await fileHandle(path)).getFile()
    return file.size
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function readSource(id: string): Promise<File> {
  return (await fileHandle(sessionPath(id, SOURCE_FILE))).getFile()
}

export async function updateManifest(
  id: string,
  patch: Partial<RecordingManifest>,
): Promise<RecordingManifest | null> {
  const path = sessionPath(id, MANIFEST_FILE)
  const stored = await readJson<RecordingManifest>(path)
  if (!stored) return null
  // Normalizing here upgrades an older-schema file on its first write.
  const next = { ...normalizeManifest(stored), ...patch }
  await writeJson(path, next)
  return next
}

export async function renameRecording(id: string, title: string): Promise<void> {
  await updateManifest(id, { title: title.trim() || 'Untitled recording' })
}

export async function setDescription(id: string, description: string): Promise<void> {
  await updateManifest(id, { description })
}

export async function moveToFolder(id: string, folderId: string | null): Promise<void> {
  await updateManifest(id, { folderId })
}

/** `null` restores automatic poster selection. */
export async function setPosterTime(id: string, posterTime: number | null): Promise<void> {
  await updateManifest(id, { posterTime })
}

export const TRASH_RETENTION_DAYS = 30

/** Soft delete: only a timestamp is written, so restore is exact. */
export async function trashRecording(id: string): Promise<void> {
  await updateManifest(id, { deletedAt: new Date().toISOString() })
}

export async function restoreRecording(id: string): Promise<void> {
  await updateManifest(id, { deletedAt: null })
}

export function daysUntilPurge(
  manifest: RecordingManifest,
  now: number = Date.now(),
): number {
  if (manifest.deletedAt === null) return TRASH_RETENTION_DAYS
  const deletedAt = Date.parse(manifest.deletedAt)
  if (!Number.isFinite(deletedAt)) return TRASH_RETENTION_DAYS
  const elapsedDays = (now - deletedAt) / 86_400_000
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsedDays))
}

/** Permanent. The Delete button uses `trashRecording` instead. */
export async function deleteRecording(id: string): Promise<void> {
  await removeSession(id)
}

export async function emptyTrash(): Promise<number> {
  const trashed = await listRecordings({ include: 'trashed' })
  for (const entry of trashed) await removeSession(entry.manifest.id)
  return trashed.length
}

/** Called on library open; there is no background process to run it on a timer. */
export async function purgeExpiredTrash(now: number = Date.now()): Promise<string[]> {
  const trashed = await listRecordings({ include: 'trashed' })
  const purged: string[] = []
  for (const entry of trashed) {
    if (daysUntilPurge(entry.manifest, now) > 0) continue
    await removeSession(entry.manifest.id)
    purged.push(entry.manifest.id)
  }
  return purged
}

/**
 * Finalizes the `source.part` left behind when a recording host died mid-capture.
 * finalize.ts is imported lazily so the library page does not load Mediabunny.
 */
export async function recoverRecording(
  id: string,
  onProgress?: (progress: number) => void,
): Promise<RecordingManifest | null> {
  const media = await sessionMedia(id)
  if (media.part === null || media.part === 0) {
    throw new Error(
      sessionState(media) === 'ready'
        ? 'This recording has already been recovered.'
        : 'The raw capture for this recording is missing, so it cannot be recovered.',
    )
  }

  await updateManifest(id, { status: 'finalizing' })
  try {
    const { finalizeRecording } = await import('./finalize.ts')
    const { duration, bytes } = await finalizeRecording(
      id,
      onProgress ? { onProgress } : {},
    )
    return updateManifest(id, { status: 'ready', duration, bytes })
  } catch (error) {
    // Revert so the UI keeps offering recovery instead of a stuck 'finalizing'.
    await updateManifest(id, { status: 'orphaned' })
    throw error
  }
}

export async function totalBytes(entries: LibraryEntry[]): Promise<number> {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0)
}

/** An EDL built for a different source duration is stale and replaced with a full one. */
export async function readEdl(id: string, sourceDuration: number): Promise<Edl> {
  const stored = await readJson<Edl>(sessionPath(id, EDL_FILE))
  if (!stored || Math.abs(stored.sourceDuration - sourceDuration) > 0.5) {
    return fullEdl(sourceDuration)
  }
  return normalize(stored)
}

export async function writeEdl(id: string, edl: Edl): Promise<void> {
  // An unedited EDL is stored as no file at all.
  if (isUnedited(edl)) {
    await removeFile(sessionPath(id, EDL_FILE))
    return
  }
  await writeJson(sessionPath(id, EDL_FILE), edl)
}

export async function revertEdits(id: string): Promise<void> {
  await removeFile(sessionPath(id, EDL_FILE))
}

export async function readTranscript(id: string): Promise<Transcript | null> {
  return readJson<Transcript>(sessionPath(id, TRANSCRIPT_FILE))
}

export async function writeTranscript(id: string, transcript: Transcript): Promise<void> {
  await writeJson(sessionPath(id, TRANSCRIPT_FILE), transcript)
}

export async function deleteTranscript(id: string): Promise<void> {
  await removeFile(sessionPath(id, TRANSCRIPT_FILE))
}

/** Derived files are caches: null just means not generated yet. */
export async function readSessionBlob(id: string, file: string): Promise<File | null> {
  try {
    return await (await fileHandle(sessionPath(id, file))).getFile()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function writeSessionBlob(id: string, file: string, blob: Blob): Promise<void> {
  await writeFile(sessionPath(id, file), blob)
}

export function readPoster(id: string): Promise<File | null> {
  return readSessionBlob(id, POSTER_FILE)
}

export function writePoster(id: string, blob: Blob): Promise<void> {
  return writeSessionBlob(id, POSTER_FILE, blob)
}

export function readPreview(id: string): Promise<File | null> {
  return readSessionBlob(id, PREVIEW_FILE)
}

export function writePreview(id: string, blob: Blob): Promise<void> {
  return writeSessionBlob(id, PREVIEW_FILE, blob)
}

export async function invalidateDerived(id: string): Promise<void> {
  await removeFile(sessionPath(id, POSTER_FILE))
  await removeFile(sessionPath(id, PREVIEW_FILE))
}

export function readPeaksFile(id: string): Promise<File | null> {
  return readSessionBlob(id, PEAKS_FILE)
}

export function devReportPath(id: string): string[] {
  return sessionPath(id, DEV_REPORT_FILE)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** "4:12", or "1:04:12" once it passes an hour. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}
