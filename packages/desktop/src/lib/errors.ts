// User-facing error text. Free of Tauri imports so Node tests can load it.

export interface IpcError {
  code: string
  message: string
  status?: number
  requestId?: string
}

export function isIpcError(e: unknown): e is IpcError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as IpcError).code === 'string' &&
    typeof (e as IpcError).message === 'string'
  )
}

/** Windows refused a write to a folder that exists, usually Controlled folder access. */
export function isBlocked(e: unknown): boolean {
  return isIpcError(e) && e.code === 'blocked'
}

/** Clearer than anything Rust or Sarvam says for these codes. */
const FRIENDLY: Record<string, string> = {
  disk_full: 'The disk is full. Free up some space and try again.',
  no_key: 'Add your Sarvam API key in Settings first.',
  invalid_key: 'Sarvam rejected the API key. Check it in Settings.',
  quota: 'Your Sarvam credits have run out. Top up at dashboard.sarvam.ai and try again.',
  rate_limited: 'Sarvam is receiving too many requests right now. Wait a minute and try again.',
  too_large: 'This file is larger or longer than Sarvam accepts on your plan.',
  network: 'Could not reach Sarvam. Check your internet connection and try again.',
  cancelled: 'Cancelled.',
}

/** For these codes Rust's message says what went wrong; these stand in when it is empty. */
const FALLBACK: Record<string, string> = {
  not_found: 'The file could not be found. It may have been moved or deleted.',
  forbidden: 'Butterfly Record is not allowed to use that location.',
  blocked:
    'Windows Security is blocking Butterfly Record from saving here (Controlled folder access). Allow the app in Windows Security or choose another library folder.',
}

/** Windows' own wording, e.g. "Access is denied. (os error 5)". */
const OS_TEXT = /\(os error \d+\)$/

/** A user-facing sentence for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isIpcError(e)) {
    const friendly = FRIENDLY[e.code]
    if (friendly) return friendly
    const detail = e.message.trim()
    const fallback = FALLBACK[e.code]
    if (fallback) {
      if (!detail) return fallback
      // Windows' sentence alone does not say what the app was doing.
      return OS_TEXT.test(detail) ? `${fallback} Windows reported: ${detail}` : detail
    }
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
