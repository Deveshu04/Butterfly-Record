import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

/** 128 bits of unlisted-URL entropy, hex so it is URL- and filename-safe. */
export function shareKey(): string {
  return randomBytes(16).toString('hex')
}

const SHARE_KEY_RE = /^[0-9a-f]{32}$/

export function isShareKey(value: string): boolean {
  return SHARE_KEY_RE.test(value)
}

export interface ByteRange {
  start: number
  /** Inclusive, as HTTP defines it. */
  end: number
}

/**
 * Single-range only; media elements never send multi-range requests.
 * null means no range (200), 'unsatisfiable' means 416.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null

  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return 'unsatisfiable'

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  let start: number
  let end: number

  if (rawStart === '') {
    // "-500" means the last 500 bytes.
    const suffix = Number(rawEnd)
    if (suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
  if (start > end || start >= size) return 'unsatisfiable'

  return { start, end: Math.min(end, size - 1) }
}

const SCRYPT_KEYLEN = 64

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex')
  return { hash: scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex'), salt }
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export function signUnlock(secret: string, shareKeyValue: string, expiresAt: number): string {
  const payload = `${shareKeyValue}.${expiresAt}`
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyUnlock(
  secret: string,
  shareKeyValue: string,
  cookie: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!cookie) return false
  const parts = cookie.split('.')
  if (parts.length !== 3) return false

  const [key, rawExpiry, signature] = parts as [string, string, string]
  if (key !== shareKeyValue) return false

  const expiresAt = Number(rawExpiry)
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false

  const expected = createHmac('sha256', secret).update(`${key}.${rawExpiry}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Non-reversible, cookie-less viewer id; the day input makes it rotate daily. */
export function viewFingerprint(
  secret: string,
  ip: string,
  userAgent: string,
  day: string,
): string {
  return createHmac('sha256', secret).update(`${ip}\n${userAgent}\n${day}`).digest('hex').slice(0, 32)
}

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Decodes tus's `Upload-Metadata`: comma-separated `key base64value` pairs. */
export function parseUploadMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ')
    if (!key) continue
    out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : ''
  }
  return out
}
