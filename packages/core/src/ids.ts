// ULIDs sort by creation time and need no escaping in URLs, filenames or Windows paths.

// Crockford base32 (no I, L, O or U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS

const MAX_TIME = 2 ** 48 - 1

/** Not monotonic within a millisecond. */
export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: timestamp ${now} out of range`)
  }

  let time = ''
  let remaining = now
  for (let i = 0; i < TIME_CHARS; i++) {
    time = ALPHABET[remaining % 32]! + time
    remaining = Math.floor(remaining / 32)
  }

  const bytes = new Uint8Array(RANDOM_CHARS)
  crypto.getRandomValues(bytes)
  let random = ''
  for (const byte of bytes) random += ALPHABET[byte & 0x1f]!

  return time + random
}

/** Creation time in epoch milliseconds. */
export function ulidTime(id: string): number {
  let time = 0
  for (let i = 0; i < TIME_CHARS; i++) {
    const index = ALPHABET.indexOf(id[i]!)
    if (index === -1) throw new TypeError(`ulidTime: "${id}" is not a ULID`)
    time = time * 32 + index
  }
  return time
}

const ULID_RE = new RegExp(`^[${ALPHABET}]{${ULID_LENGTH}}$`)

export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}
