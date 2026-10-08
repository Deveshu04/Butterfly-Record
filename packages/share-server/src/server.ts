import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { Config } from './config.ts'
import type { Store } from './db.ts'
import { embedPage, messagePage, passwordPage, watchPage } from './page.ts'
import {
  hashPassword,
  isShareKey,
  parseCookies,
  parseRange,
  parseUploadMetadata,
  shareKey as newShareKey,
  signUnlock,
  today,
  verifyPassword,
  verifyUnlock,
  viewFingerprint,
} from './util.ts'

const TUS_VERSION = '1.0.0'
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000
/** Count a play once the viewer is 5s in, or three-quarters through. */
export const WATCH_SECONDS = 5

export interface Deps {
  config: Config
  store: Store
}

export function createHandler({ config, store }: Deps) {
  const mediaPath = (key: string) => join(config.mediaDir, `${key}.webm`)

  function tusHeaders(res: ServerResponse): void {
    res.setHeader('Tus-Resumable', TUS_VERSION)
    res.setHeader('Tus-Version', TUS_VERSION)
    res.setHeader('Tus-Extension', 'creation,creation-defer-length,termination')
    res.setHeader('Tus-Max-Size', String(config.maxUploadBytes))
  }

  function cors(res: ServerResponse): void {
    // Wildcard is safe: mutating endpoints are authorised by bearer token, never by cookie.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization,Content-Type,Tus-Resumable,Upload-Length,Upload-Offset,Upload-Defer-Length,Upload-Metadata',
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Location,Tus-Resumable,Tus-Version,Tus-Extension,Tus-Max-Size,Upload-Offset,Upload-Length',
    )
  }

  function authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    return header === `Bearer ${config.uploadToken}`
  }

  function send(res: ServerResponse, status: number, body: string, type = 'text/html'): void {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` })
    res.end(body)
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    send(res, status, JSON.stringify(body), 'application/json')
  }

  async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('Request body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Expired links behave exactly like links that never existed. */
  function isGone(record: { expiresAt: string | null }): boolean {
    return record.expiresAt !== null && new Date(record.expiresAt).getTime() < Date.now()
  }

  function clientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim()
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  function fingerprintFor(req: IncomingMessage): string {
    return viewFingerprint(
      config.cookieSecret,
      clientIp(req),
      String(req.headers['user-agent'] ?? ''),
      today(),
    )
  }

  async function createUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const metadata = parseUploadMetadata(req.headers['upload-metadata'] as string | undefined)
    const deferred = req.headers['upload-defer-length'] === '1'
    const rawLength = req.headers['upload-length']
    const uploadLength = deferred || rawLength === undefined ? null : Number(rawLength)

    if (uploadLength !== null && (!Number.isFinite(uploadLength) || uploadLength < 0)) {
      send(res, 400, 'Invalid Upload-Length')
      return
    }
    if (uploadLength !== null && uploadLength > config.maxUploadBytes) {
      send(res, 413, 'Upload exceeds this server’s maximum size')
      return
    }

    const key = newShareKey()
    const password = metadata.password ? hashPassword(metadata.password) : null

    store.create({
      shareKey: key,
      recordingId: metadata.id ?? key,
      title: metadata.title ?? '',
      contentType: metadata.contentType ?? 'video/webm',
      uploadLength,
      duration: metadata.duration ? Number(metadata.duration) : null,
      width: metadata.width ? Number(metadata.width) : null,
      height: metadata.height ? Number(metadata.height) : null,
      expiresAt: metadata.expiresAt ?? null,
      allowDownload: metadata.allowDownload !== 'false',
      password,
    })

    // Create the file immediately so PATCH can always open it 'r+'.
    await (await open(mediaPath(key), 'w')).close()

    tusHeaders(res)
    res.setHeader('Location', `${config.publicUrl}/v1/uploads/${key}`)
    res.setHeader('Upload-Offset', '0')
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        shareKey: key,
        shareUrl: `${config.publicUrl}/v/${key}`,
        uploadUrl: `${config.publicUrl}/v1/uploads/${key}`,
      }),
    )
  }

  function headUpload(key: string, res: ServerResponse): void {
    const record = store.get(key)
    if (!record) {
      send(res, 404, 'No such upload')
      return
    }
    tusHeaders(res)
    res.setHeader('Upload-Offset', String(record.uploadOffset))
    if (record.uploadLength !== null) res.setHeader('Upload-Length', String(record.uploadLength))
    else res.setHeader('Upload-Defer-Length', '1')
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(200)
    res.end()
  }

  async function patchUpload(
    key: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const record = store.get(key)
    if (!record) {
      send(res, 404, 'No such upload')
      return
    }

    const offset = Number(req.headers['upload-offset'])
    if (!Number.isFinite(offset)) {
      send(res, 400, 'Missing Upload-Offset')
      return
    }
    // tus: on 409 the client resyncs via HEAD instead of corrupting the file.
    if (offset !== record.uploadOffset) {
      tusHeaders(res)
      res.setHeader('Upload-Offset', String(record.uploadOffset))
      send(res, 409, 'Offset mismatch')
      return
    }

    // A deferred-length upload learns its size on the final PATCH.
    const declaredLength = req.headers['upload-length']
    if (record.uploadLength === null && declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (Number.isFinite(length) && length >= 0) {
        if (length > config.maxUploadBytes) {
          send(res, 413, 'Upload exceeds this server’s maximum size')
          return
        }
        store.setLength(key, length)
      }
    }

    const target = createWriteStream(mediaPath(key), { flags: 'r+', start: offset })
    try {
      await pipeline(req, target)
    } catch {
      // Dropped connection: keep the bytes that landed so the client can resume.
      const written = offset + target.bytesWritten
      store.setOffset(key, written)
      tusHeaders(res)
      res.setHeader('Upload-Offset', String(written))
      res.writeHead(460)
      res.end()
      return
    }

    const written = offset + target.bytesWritten
    if (written > config.maxUploadBytes) {
      store.setStatus(key, 'failed')
      send(res, 413, 'Upload exceeds this server’s maximum size')
      return
    }

    store.setOffset(key, written)
    const total = store.get(key)?.uploadLength ?? null
    if (total !== null && written >= total) store.setStatus(key, 'ready')

    tusHeaders(res)
    res.setHeader('Upload-Offset', String(written))
    res.writeHead(204)
    res.end()
  }

  async function deleteUpload(key: string, res: ServerResponse): Promise<void> {
    store.remove(key)
    await rm(mediaPath(key), { force: true })
    tusHeaders(res)
    res.writeHead(204)
    res.end()
  }

  async function patchMetadata(
    key: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!store.get(key)) {
      send(res, 404, 'No such upload')
      return
    }
    const body = JSON.parse(await readBody(req)) as {
      title?: string
      duration?: number
      width?: number
      height?: number
      finalize?: boolean
    }
    store.updateMetadata(key, body)
    if (body.finalize) store.setStatus(key, 'ready')
    sendJson(res, 200, store.get(key))
  }

  async function serveMedia(
    key: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const record = store.get(key)
    if (!record || isGone(record)) {
      send(res, 404, 'Not found')
      return
    }
    if (record.passwordHash && !verifyUnlock(config.cookieSecret, key, parseCookies(req.headers.cookie)[unlockCookie(key)])) {
      send(res, 403, 'Locked')
      return
    }

    let size: number
    try {
      size = (await stat(mediaPath(key))).size
    } catch {
      send(res, 404, 'Not found')
      return
    }

    // Counted on media requests, not page loads, so only started playback counts.
    store.markView(key, fingerprintFor(req), today())

    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }

    const headers: Record<string, string> = {
      'Content-Type': record.contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    }
    if (url.searchParams.has('download') && record.allowDownload) {
      headers['Content-Disposition'] =
        `attachment; filename="${(record.title || 'recording').replace(/["\\]/g, '')}.webm"`
    }

    if (!range) {
      headers['Content-Length'] = String(size)
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await pipeline(createReadStream(mediaPath(key)), res)
      return
    }

    headers['Content-Length'] = String(range.end - range.start + 1)
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    res.writeHead(206, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeline(createReadStream(mediaPath(key), { start: range.start, end: range.end }), res)
  }

  const unlockCookie = (key: string) => `bf_unlock_${key.slice(0, 8)}`

  async function serveWatchPage(
    key: string,
    req: IncomingMessage,
    res: ServerResponse,
    failedUnlock = false,
  ): Promise<void> {
    const record = store.get(key)
    if (!record || isGone(record)) {
      send(res, 404, messagePage(404, 'Not found', 'This link has expired or never existed.'))
      return
    }

    if (record.passwordHash) {
      const cookie = parseCookies(req.headers.cookie)[unlockCookie(key)]
      if (!verifyUnlock(config.cookieSecret, key, cookie)) {
        send(res, failedUnlock ? 401 : 200, passwordPage(key, failedUnlock))
        return
      }
    }

    send(res, 200, watchPage(record, config.publicUrl))
  }

  async function unlock(key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = store.get(key)
    if (!record?.passwordHash || !record.passwordSalt) {
      res.writeHead(302, { Location: `/v/${key}` })
      res.end()
      return
    }

    const body = new URLSearchParams(await readBody(req, 4096))
    const password = body.get('password') ?? ''

    if (!verifyPassword(password, record.passwordHash, record.passwordSalt)) {
      await serveWatchPage(key, req, res, true)
      return
    }

    const token = signUnlock(config.cookieSecret, key, Date.now() + UNLOCK_TTL_MS)
    res.writeHead(302, {
      Location: `/v/${key}`,
      'Set-Cookie': `${unlockCookie(key)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_TTL_MS / 1000}`,
    })
    res.end()
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.publicUrl)
    const path = url.pathname
    cors(res)

    try {
      if (req.method === 'OPTIONS') {
        tusHeaders(res)
        res.writeHead(204)
        res.end()
        return
      }

      if (path === '/healthz') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === '/v1/uploads' && req.method === 'POST') {
        if (!authorised(req)) {
          send(res, 401, 'Unauthorized')
          return
        }
        await createUpload(req, res)
        return
      }

      const uploadMatch = path.match(/^\/v1\/uploads\/([0-9a-f]{32})(\/meta)?$/)
      if (uploadMatch) {
        if (!authorised(req)) {
          send(res, 401, 'Unauthorized')
          return
        }
        const key = uploadMatch[1]!
        if (uploadMatch[2]) {
          if (req.method !== 'PATCH' && req.method !== 'POST') {
            send(res, 405, 'Method not allowed')
            return
          }
          await patchMetadata(key, req, res)
          return
        }
        if (req.method === 'HEAD') return headUpload(key, res)
        if (req.method === 'PATCH') return patchUpload(key, req, res)
        if (req.method === 'DELETE') return deleteUpload(key, res)
        send(res, 405, 'Method not allowed')
        return
      }

      const beacon = path.match(/^\/v1\/beacon\/([0-9a-f]{32})$/)
      if (beacon && req.method === 'POST') {
        store.markWatched(beacon[1]!, fingerprintFor(req))
        res.writeHead(204)
        res.end()
        return
      }

      if (path === '/v1/oembed') {
        const target = url.searchParams.get('url') ?? ''
        const key = target.match(/\/v\/([0-9a-f]{32})/)?.[1]
        const record = key ? store.get(key) : null
        if (!record || isGone(record)) {
          sendJson(res, 404, { error: 'Not found' })
          return
        }
        sendJson(res, 200, {
          version: '1.0',
          type: 'video',
          provider_name: 'Butterfly Record',
          provider_url: config.publicUrl,
          title: record.title || 'Untitled recording',
          width: record.width ?? 1280,
          height: record.height ?? 720,
          duration: record.duration ?? undefined,
          html: `<iframe src="${config.publicUrl}/embed/${record.shareKey}" width="${record.width ?? 1280}" height="${record.height ?? 720}" frameborder="0" allowfullscreen></iframe>`,
        })
        return
      }

      const embed = path.match(/^\/embed\/([0-9a-f]{32})$/)
      if (embed) {
        const record = store.get(embed[1]!)
        if (!record || isGone(record) || record.passwordHash) {
          send(res, 404, 'Not found')
          return
        }
        send(res, 200, embedPage(record, config.publicUrl))
        return
      }

      const media = path.match(/^\/media\/([0-9a-f]{32})$/)
      if (media && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveMedia(media[1]!, req, res, url)
        return
      }

      const unlockRoute = path.match(/^\/v\/([0-9a-f]{32})\/unlock$/)
      if (unlockRoute && req.method === 'POST') {
        await unlock(unlockRoute[1]!, req, res)
        return
      }

      const watch = path.match(/^\/v\/([^/]+)$/)
      if (watch && req.method === 'GET') {
        if (!isShareKey(watch[1]!)) {
          send(res, 404, messagePage(404, 'Not found', 'That is not a valid share link.'))
          return
        }
        await serveWatchPage(watch[1]!, req, res)
        return
      }

      send(res, 404, messagePage(404, 'Not found', 'Nothing lives at this address.'))
    } catch (error) {
      // Never leak an internal message to a public page.
      console.error('[butterfly-share]', error)
      if (!res.headersSent) {
        send(res, 500, messagePage(500, 'Something went wrong', 'The server could not complete that request.'))
      } else {
        res.end()
      }
    }
  }
}
