// The recordings folder handle lives in IndexedDB at the extension origin, which a
// content script cannot read, so its display name and permission are mirrored in storage.local.

import type { BackgroundRequest } from './messages.ts'

const FOLDER_NAME_KEY = 'recordings-folder-name'
const NEEDS_RECONNECT_KEY = 'recordings-folder-needs-reconnect'
const PROMPT_DISMISSED_KEY = 'recordings-folder-prompt-dismissed'

export async function readFolderName(): Promise<string | null> {
  const stored = await chrome.storage.local.get(FOLDER_NAME_KEY)
  const name = stored[FOLDER_NAME_KEY]
  return typeof name === 'string' ? name : null
}

export async function writeFolderName(name: string | null): Promise<void> {
  if (name === null) await chrome.storage.local.remove(FOLDER_NAME_KEY)
  else await chrome.storage.local.set({ [FOLDER_NAME_KEY]: name })
}

export function onFolderNameChanged(listener: (name: string | null) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    const change = changes[FOLDER_NAME_KEY]
    if (area !== 'local' || !change) return
    listener(typeof change.newValue === 'string' ? change.newValue : null)
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

/** True once Chrome has dropped the folder's permission, so recordings go to Downloads. */
export async function readFolderNeedsReconnect(): Promise<boolean> {
  const stored = await chrome.storage.local.get(NEEDS_RECONNECT_KEY)
  return stored[NEEDS_RECONNECT_KEY] === true
}

export async function writeFolderNeedsReconnect(needed: boolean): Promise<void> {
  // An offscreen document has no chrome.storage, so the worker writes it instead.
  if (!chrome.storage) {
    const request: BackgroundRequest = {
      target: 'background',
      type: 'set-folder-needs-reconnect',
      needed,
    }
    await chrome.runtime.sendMessage(request)
    return
  }
  await chrome.storage.local.set({ [NEEDS_RECONNECT_KEY]: needed })
}

export function onFolderNeedsReconnectChanged(listener: (needed: boolean) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    const change = changes[NEEDS_RECONNECT_KEY]
    if (area !== 'local' || !change) return
    listener(change.newValue === true)
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

export async function isFolderPromptDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get(PROMPT_DISMISSED_KEY)
  return stored[PROMPT_DISMISSED_KEY] === true
}

export async function dismissFolderPrompt(): Promise<void> {
  await chrome.storage.local.set({ [PROMPT_DISMISSED_KEY]: true })
}
