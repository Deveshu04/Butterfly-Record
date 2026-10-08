import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Config {
  port: number
  host: string
  dataDir: string
  mediaDir: string
  databasePath: string
  /** Absolute base URL, used to mint share links and oEmbed payloads. */
  publicUrl: string
  uploadToken: string
  cookieSecret: string
  maxUploadBytes: number
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

function persistentSecret(dataDir: string, filename: string): string {
  const path = join(dataDir, filename)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // First run.
  }
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  return secret
}

export function loadConfig(): Config {
  const dataDir = env('BUTTERFLY_DATA_DIR') ?? '/data'
  const mediaDir = join(dataDir, 'media')
  mkdirSync(mediaDir, { recursive: true })

  const port = Number(env('PORT') ?? 8080)
  const host = env('HOST') ?? '0.0.0.0'

  return {
    port,
    host,
    dataDir,
    mediaDir,
    databasePath: join(dataDir, 'butterfly-share.db'),
    publicUrl: (env('BUTTERFLY_PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    uploadToken: env('BUTTERFLY_UPLOAD_TOKEN') ?? persistentSecret(dataDir, 'upload-token'),
    cookieSecret: env('BUTTERFLY_COOKIE_SECRET') ?? persistentSecret(dataDir, 'cookie-secret'),
    maxUploadBytes: Number(env('BUTTERFLY_MAX_UPLOAD_BYTES') ?? 20 * 1024 ** 3),
  }
}
