// Folders are labels (a manifest's `folderId`), not OPFS directories.

import { FOLDERS_FILE, libraryPath, readJson, writeJson } from './opfs.ts'
import { ulid } from './ids.ts'

export const FOLDERS_SCHEMA = 1

export interface Folder {
  id: string
  name: string
  parentId: string | null
  createdAt: string
}

interface FolderStore {
  schema: typeof FOLDERS_SCHEMA
  folders: Folder[]
}

export interface FolderNode {
  folder: Folder
  depth: number
}

const UNTITLED = 'New folder'
const MAX_NAME = 60

function emptyStore(): FolderStore {
  return { schema: FOLDERS_SCHEMA, folders: [] }
}

async function read(): Promise<FolderStore> {
  const stored = await readJson<FolderStore>(libraryPath(FOLDERS_FILE))
  if (!stored || !Array.isArray(stored.folders)) return emptyStore()
  return { schema: FOLDERS_SCHEMA, folders: stored.folders }
}

async function write(store: FolderStore): Promise<void> {
  await writeJson(libraryPath(FOLDERS_FILE), store)
}

export async function listFolders(): Promise<Folder[]> {
  return (await read()).folders
}

export function cleanFolderName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
  return trimmed.length > 0 ? trimmed : UNTITLED
}

export async function createFolder(name: string, parentId: string | null = null): Promise<Folder> {
  const store = await read()
  const folder: Folder = {
    id: ulid(),
    name: cleanFolderName(name),
    // A parent that has since been deleted would strand the new folder.
    parentId: parentId && store.folders.some((f) => f.id === parentId) ? parentId : null,
    createdAt: new Date().toISOString(),
  }
  store.folders.push(folder)
  await write(store)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const store = await read()
  const folder = store.folders.find((candidate) => candidate.id === id)
  if (!folder) return
  folder.name = cleanFolderName(name)
  await write(store)
}

/** Refuses any move that would create a cycle, which would make folders unreachable. */
export async function moveFolder(id: string, parentId: string | null): Promise<boolean> {
  const store = await read()
  const folder = store.folders.find((candidate) => candidate.id === id)
  if (!folder || id === parentId) return false

  if (parentId !== null) {
    if (!store.folders.some((candidate) => candidate.id === parentId)) return false
    if (ancestorIds(store.folders, parentId).includes(id)) return false
  }

  folder.parentId = parentId
  await write(store)
  return true
}

/**
 * Child folders move up to the parent. Recordings keep the stale id, which
 * `folderOf` resolves to null.
 * @returns ids of folders whose recordings the caller should re-file to `folder.parentId`.
 */
export async function deleteFolder(id: string): Promise<string[]> {
  const store = await read()
  const folder = store.folders.find((candidate) => candidate.id === id)
  if (!folder) return []

  for (const child of store.folders) {
    if (child.parentId === id) child.parentId = folder.parentId
  }
  store.folders = store.folders.filter((candidate) => candidate.id !== id)
  await write(store)
  return [id]
}

/** Nearest first. */
export function ancestorIds(folders: Folder[], id: string): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const chain: string[] = []
  let cursor = byId.get(id)?.parentId ?? null
  // Bounded by the folder count: a corrupt file with a cycle must not hang.
  while (cursor !== null && chain.length <= folders.length) {
    chain.push(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  return chain
}

/** e.g. "Client work / Acme". */
export function folderPath(folders: Folder[], id: string | null): string {
  if (id === null) return ''
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const self = byId.get(id)
  if (!self) return ''
  return [...ancestorIds(folders, id).reverse(), id]
    .map((step) => byId.get(step)?.name ?? '')
    .filter(Boolean)
    .join(' / ')
}

/** Depth-first. A folder whose parent is missing is shown at the top level, not dropped. */
export function folderTree(folders: Folder[]): FolderNode[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const children = new Map<string | null, Folder[]>()
  for (const folder of folders) {
    const parent = folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null
    const bucket = children.get(parent)
    if (bucket) bucket.push(folder)
    else children.set(parent, [folder])
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name))
  }

  const out: FolderNode[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      out.push({ folder, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function folderAndDescendants(folders: Folder[], id: string): Set<string> {
  const found = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId !== null && found.has(folder.parentId) && !found.has(folder.id)) {
        found.add(folder.id)
        grew = true
      }
    }
  }
  return found
}

export function folderOf(folders: Folder[], folderId: string | null): Folder | null {
  if (folderId === null) return null
  return folders.find((folder) => folder.id === folderId) ?? null
}
