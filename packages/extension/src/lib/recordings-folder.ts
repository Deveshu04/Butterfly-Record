// A user-picked folder that finished recordings are copied into. Picking it and
// requesting permission need a user gesture on a visible extension page; copying
// works from any extension document once permission is granted, but not from the
// service worker.

import {
  isNotFound,
  readJson,
  readSource,
  removeFile,
  safeFilename,
  sessionPath,
  writeJson,
} from '@butterfly-record/core'

import { writeFolderName, writeFolderNeedsReconnect } from './save-destination.ts'

/** Per-session sidecar recording where the finished file was saved. */
export const SAVED_FILE = 'saved.json'

export interface SavedRecord {
  kind: 'folder' | 'downloads'
  /** File name in the recordings folder, or in Downloads/Butterfly Record. */
  name: string
  /** ISO 8601. */
  at: string
}

const DB_NAME = 'butterfly-record'
const DB_STORE = 'handles'
const FOLDER_KEY = 'recordings-folder'
const PICKER_ID = 'butterfly-recordings'
const PARTIAL_SUFFIX = '.partial'
const SWAP_SUFFIX = '.crswap'
const COPY_LOCK = 'butterfly-record:folder-copy'
const MAX_COPIES = 999
const READ_WRITE = { mode: 'readwrite' } as const

// Shipped by Chrome but not yet declared by TypeScript's DOM library.
interface PermissionedHandle {
  queryPermission(descriptor: typeof READ_WRITE): Promise<PermissionState>
  requestPermission(descriptor: typeof READ_WRITE): Promise<PermissionState>
}

interface RenamableHandle {
  move(newName: string): Promise<void>
}

interface DirectoryPickerWindow {
  showDirectoryPicker(options: {
    id: string
    mode: 'readwrite'
    startIn: 'videos'
  }): Promise<FileSystemDirectoryHandle>
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode)
      const request = run(transaction.objectStore(DB_STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const stored = await withStore<unknown>('readonly', (store) => store.get(FOLDER_KEY))
  return stored instanceof FileSystemDirectoryHandle ? stored : null
}

/** Opens the folder picker and remembers the choice. Null when the user cancels. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | null> {
  let folder: FileSystemDirectoryHandle
  try {
    folder = await (window as unknown as DirectoryPickerWindow).showDirectoryPicker({
      id: PICKER_ID,
      mode: 'readwrite',
      startIn: 'videos',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
  await withStore('readwrite', (store) => store.put(folder, FOLDER_KEY))
  await writeFolderName(folder.name)
  await mirrorAccess(true)
  return folder
}

/** Also mirrored to storage.local, for the overlay. */
export async function folderPermission(
  folder: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const state = await (folder as unknown as PermissionedHandle).queryPermission(READ_WRITE)
  await mirrorAccess(state === 'granted')
  return state
}

/** Shows Chrome's prompt unless already granted; needs a user gesture. */
export async function requestFolderPermission(folder: FileSystemDirectoryHandle): Promise<boolean> {
  const granted =
    (await (folder as unknown as PermissionedHandle).requestPermission(READ_WRITE)) === 'granted'
  await mirrorAccess(granted)
  return granted
}

/** Refreshes the mirrored permission; the worker relays this here because it cannot query it. */
export async function checkFolderAccess(): Promise<null> {
  const folder = await loadFolder()
  if (folder) await folderPermission(folder)
  else await mirrorAccess(true)
  return null
}

/** Best effort: the overlay's hint must never stand in the way of saving. */
function mirrorAccess(granted: boolean): Promise<void> {
  return writeFolderNeedsReconnect(!granted).catch((error: unknown) => {
    console.warn('[butterfly-record] could not record the folder permission', error)
  })
}

/** Null when nothing was recorded, including when the file is unreadable. */
export async function readSaved(id: string): Promise<SavedRecord | null> {
  try {
    return await readJson<SavedRecord>(sessionPath(id, SAVED_FILE))
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export async function writeSaved(
  id: string,
  kind: SavedRecord['kind'],
  name: string,
): Promise<SavedRecord> {
  const record: SavedRecord = { kind, name, at: new Date().toISOString() }
  await writeJson(sessionPath(id, SAVED_FILE), record)
  return record
}

export function forgetSaved(id: string): Promise<void> {
  return removeFile(sessionPath(id, SAVED_FILE))
}

/** True when the recording has no copy in the recordings folder yet. */
export async function needsFolderCopy(id: string): Promise<boolean> {
  const saved = await readSaved(id)
  return saved === null || saved.kind === 'downloads'
}

/** True when the recording was never saved outside the browser. */
export async function isOnlyInBrowser(id: string): Promise<boolean> {
  return (await readSaved(id)) === null
}

/** Copies a finished recording into the folder as "<title>.webm" and records it. */
export async function copyToFolder(
  folder: FileSystemDirectoryHandle,
  id: string,
  title: string,
): Promise<SavedRecord> {
  const name = await writeIntoFolder(folder, safeFilename(title), '.webm', await readSource(id))
  return writeSaved(id, 'folder', name)
}

export type FolderDelivery =
  | { status: 'none' }
  | { status: 'needs-permission'; folder: string }
  | { status: 'saved'; folder: string; record: SavedRecord }

/** Anything but 'saved' means the caller falls back to Downloads. */
export async function copyToGrantedFolder(id: string, title: string): Promise<FolderDelivery> {
  const folder = await loadFolder()
  if (!folder) return { status: 'none' }
  if ((await folderPermission(folder)) !== 'granted') {
    return { status: 'needs-permission', folder: folder.name }
  }
  return { status: 'saved', folder: folder.name, record: await copyToFolder(folder, id, title) }
}

/**
 * One copy at a time across every extension page, so a partial file seen while holding the
 * lock was left by a copy whose page died. Chrome releases the lock with the page.
 */
function writeIntoFolder(
  folder: FileSystemDirectoryHandle,
  stem: string,
  extension: string,
  data: Blob,
): Promise<string> {
  return navigator.locks.request(COPY_LOCK, () => writeLocked(folder, stem, extension, data))
}

async function writeLocked(
  folder: FileSystemDirectoryHandle,
  stem: string,
  extension: string,
  data: Blob,
): Promise<string> {
  const name = await availableName(folder, stem, extension)

  if ('move' in FileSystemFileHandle.prototype) {
    const partial = `${name}${PARTIAL_SUFFIX}`
    const handle = await folder.getFileHandle(partial, { create: true })
    try {
      await streamInto(handle, data)
    } catch (error) {
      await removeQuietly(folder, partial)
      throw error
    }
    try {
      await (handle as unknown as RenamableHandle).move(name)
      return name
    } catch (error) {
      // Not every file system supports renaming; write in place instead.
      console.warn('[butterfly-record] could not rename the finished file', error)
      await removeQuietly(folder, partial)
    }
  }

  const finalName = await availableName(folder, stem, extension)
  const handle = await folder.getFileHandle(finalName, { create: true })
  try {
    await streamInto(handle, data)
  } catch (error) {
    await removeQuietly(folder, finalName)
    throw error
  }
  return finalName
}

/** pipeTo closes the writable on success, committing it, and aborts it on failure. */
async function streamInto(handle: FileSystemFileHandle, data: Blob): Promise<void> {
  const writable = await handle.createWritable()
  await data.stream().pipeTo(writable)
}

/** "<stem>.webm", then "<stem> (2).webm". Called under the copy lock. */
async function availableName(
  folder: FileSystemDirectoryHandle,
  stem: string,
  extension: string,
): Promise<string> {
  for (let copy = 1; copy <= MAX_COPIES; copy++) {
    const name = copy === 1 ? `${stem}${extension}` : `${stem} (${copy})${extension}`
    if (await exists(folder, name)) continue
    await removeLeftover(folder, `${name}${PARTIAL_SUFFIX}`)
    return name
  }
  throw new Error(`Too many files in this folder are named “${stem}”.`)
}

async function exists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    // A subfolder with that name.
    if (error instanceof DOMException && error.name === 'TypeMismatchError') return true
    throw error
  }
}

/** A partial file and Chrome's swap file, left by a copy that never finished. */
async function removeLeftover(folder: FileSystemDirectoryHandle, partial: string): Promise<void> {
  try {
    await folder.getFileHandle(partial)
  } catch {
    return
  }
  await removeQuietly(folder, partial)
  await folder.removeEntry(`${partial}${SWAP_SUFFIX}`).catch(() => {})
}

async function removeQuietly(folder: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await folder.removeEntry(name)
  } catch (error) {
    if (!isNotFound(error)) console.warn(`[butterfly-record] could not remove ${name}`, error)
  }
}
