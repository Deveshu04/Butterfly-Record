// Whether the library folder can be written to, checked ahead of time: the recorder must not
// await anything between the click and the screen picker.

import { isBlocked, libraryCheckAccess, type LibraryAccess } from './ipc.ts'

export type StorageIntent = 'record' | 'import' | 'notice'

export interface StoragePrompt {
  intent: StorageIntent
  /** Runs the refused action again, from the click that closes the dialog. */
  retry: (() => void) | null
}

let status = $state<LibraryAccess | null>(null)
let prompt = $state<StoragePrompt | null>(null)
let latest = 0

/** Probes the library folder. null when the check itself failed, which counts as unknown. */
async function check(): Promise<LibraryAccess | null> {
  const run = ++latest
  try {
    const result = await libraryCheckAccess()
    if (run === latest) status = result
    return result
  } catch (error) {
    console.warn('[butterfly-record] storage check failed', error)
    return null
  }
}

/** Synchronous gate before writing to the library: opens the dialog instead when the last check failed. */
function allow(intent: StorageIntent, retry: (() => void) | null = null): boolean {
  if (status === null || status.ok) return true
  prompt = { intent, retry }
  return false
}

/** Opens the dialog for a write Windows refused; false for any other error. */
function report(error: unknown, intent: StorageIntent, retry: (() => void) | null = null): boolean {
  if (!isBlocked(error)) return false
  void check().then(() => {
    prompt = { intent, retry }
  })
  return true
}

// Back from Windows Security after allowing the app.
window.addEventListener('focus', () => {
  if (status && !status.ok) void check()
})

export const storageAccess = {
  get status(): LibraryAccess | null {
    return status
  },
  get blocked(): boolean {
    return status !== null && !status.ok
  },
  get prompt(): StoragePrompt | null {
    return prompt
  },
  check,
  allow,
  report,
  open(): void {
    prompt = { intent: 'notice', retry: null }
  },
  close(): void {
    prompt = null
  },
}
