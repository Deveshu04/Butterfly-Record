// Windows also rejects names ending in a dot or space, and reserved device names
// (CON, NUL, COM1, ...) even when followed by an extension.

const ILLEGAL = /[\\/:*?"<>|]/g
// Built from a string so no literal control byte ever appears in this source.
const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const INFORMATIVE = /[\p{L}\p{N}]/u

const MAX_LENGTH = 120
const FALLBACK = 'Recording'

/** Returns a single non-empty path segment that Windows accepts. */
export function safeFilename(title: string, fallback = FALLBACK): string {
  let name = title
    .replace(ILLEGAL, '-')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH)
    // Slicing can split a surrogate pair, and a lone surrogate is rejected by JSON IPC.
    .replace(/[\uD800-\uDBFF]$/, '')
    // Slicing can leave a trailing space, and Explorer drops trailing dots.
    .replace(/[. ]+$/, '')

  if (!INFORMATIVE.test(name)) name = fallback
  // A reserved name is only reserved as the whole stem, so a suffix clears it.
  if (RESERVED.test(name)) name = `${name}-recording`

  return name
}

export function safeFilenameWithExtension(title: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  return `${safeFilename(title)}${ext}`
}
