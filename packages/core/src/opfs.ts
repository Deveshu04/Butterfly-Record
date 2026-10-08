import type { StreamTargetChunk } from 'mediabunny'

export const SESSIONS_DIR = 'sessions'
export const PART_FILE = 'source.part'
export const SOURCE_FILE = 'source.webm'
/** Finalize output until it is verified and renamed to SOURCE_FILE. */
export const NEXT_SOURCE_FILE = 'source.next.webm'
export const MANIFEST_FILE = 'manifest.json'
export const POSTER_FILE = 'poster.jpg'
export const PREVIEW_FILE = 'preview.webm'
export const TRANSCRIPT_FILE = 'transcript.json'
export const EDL_FILE = 'edl.json'
export const PEAKS_FILE = 'peaks.json'
export const DEV_REPORT_FILE = 'devreport.json'
/** Editor scratch output; deleted after download. */
export const EXPORT_FILE = 'export.webm'

// Outside `sessions/` so every entry in `sessions/` is a recording.
export const LIBRARY_DIR = 'library'
export const FOLDERS_FILE = 'folders.json'

export function sessionPath(id: string, file: string): string[] {
  return [SESSIONS_DIR, id, file]
}

export function libraryPath(file: string): string[] {
  return [LIBRARY_DIR, file]
}

/** The last element of `path` is a file name and is not created here. */
export async function directoryFor(
  path: string[],
  { create = false }: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const segment of path.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create })
  }
  return dir
}

export async function fileHandle(
  path: string[],
  { create = false }: { create?: boolean } = {},
): Promise<FileSystemFileHandle> {
  const dir = await directoryFor(path, { create })
  return dir.getFileHandle(path[path.length - 1]!, { create })
}

export async function readFile(path: string[]): Promise<File> {
  const handle = await fileHandle(path)
  return handle.getFile()
}

export async function readJson<T>(path: string[]): Promise<T | null> {
  try {
    const file = await readFile(path)
    // A first write that never completed (a crash, or an earlier build) leaves an empty file.
    if (file.size === 0) return null
    return JSON.parse(await file.text()) as T
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function writeJson(path: string[], value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2))
}

/**
 * Replaces the file's contents. A failed write leaves the previous contents in place, or no
 * file at all when there was none before.
 */
export async function writeFile(path: string[], data: Blob | string): Promise<void> {
  const dir = await directoryFor(path, { create: true })
  const name = path[path.length - 1]!
  const existed = await dir.getFileHandle(name).then(
    () => true,
    (error: unknown) => {
      if (isNotFound(error)) return false
      throw error
    },
  )
  const handle = await dir.getFileHandle(name, { create: true })
  try {
    const writable = await handle.createWritable()
    try {
      await writable.write(data)
    } catch (error) {
      // close() would commit the partial write.
      await writable.abort().catch(() => {})
      throw error
    }
    await writable.close()
  } catch (error) {
    // Getting the handle created the file empty; readers would take that for corrupt data.
    if (!existed) await dir.removeEntry(name).catch(() => {})
    throw error
  }
}

/**
 * Runs `write` against a fresh writable and commits only if it resolves. On any failure the
 * writable is aborted and the file removed, so no partial file is left behind.
 */
export async function writeScratchFile(
  path: string[],
  write: (writable: FileSystemWritableFileStream) => Promise<void>,
): Promise<File> {
  const handle = await fileHandle(path, { create: true })
  try {
    const writable = await handle.createWritable()
    try {
      await write(writable)
    } catch (error) {
      await writable.abort().catch(() => {})
      throw error
    }
    await writable.close()
    return await handle.getFile()
  } catch (error) {
    await removeFile(path).catch(() => {})
    throw error
  }
}

/**
 * Mediabunny closes its stream on cancel as well as on success, and closing an OPFS writable
 * commits it. This forwards writes only, so the caller alone decides to commit or abort.
 */
export function uncommittedTarget(
  writable: FileSystemWritableFileStream,
): WritableStream<StreamTargetChunk> {
  return new WritableStream<StreamTargetChunk>({
    write: (chunk) => writable.write({ type: 'write', data: chunk.data, position: chunk.position }),
  })
}

export async function removeFile(path: string[]): Promise<void> {
  try {
    const dir = await directoryFor(path)
    await dir.removeEntry(path[path.length - 1]!)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

export async function removeSession(id: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const sessions = await root.getDirectoryHandle(SESSIONS_DIR)
    await sessions.removeEntry(id, { recursive: true })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

/** Newest first; ULIDs sort by creation time. */
export async function listSessionIds(): Promise<string[]> {
  const ids: string[] = []
  try {
    const root = await navigator.storage.getDirectory()
    const sessions = await root.getDirectoryHandle(SESSIONS_DIR)
    for await (const [name, handle] of sessions.entries()) {
      if (handle.kind === 'directory') ids.push(name)
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  return ids.sort().reverse()
}

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

export function isQuotaExceeded(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      // Older Chrome surfaces OPFS exhaustion through the generic code.
      error.name === 'NotAllowedError')
  )
}

export interface StorageBudget {
  quota: number
  usage: number
  available: number
}

export async function storageBudget(): Promise<StorageBudget> {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate()
  return { quota, usage, available: Math.max(0, quota - usage) }
}

/**
 * `unlimitedStorage` lifts the quota but does not prevent eviction under disk
 * pressure; only persist() does. Safe to call repeatedly.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}
