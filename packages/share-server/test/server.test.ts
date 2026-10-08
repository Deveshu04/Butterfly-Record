import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Config } from '../src/config.ts'
import { Store } from '../src/db.ts'
import { createHandler } from '../src/server.ts'
import {
  hashPassword,
  parseRange,
  parseUploadMetadata,
  signUnlock,
  verifyPassword,
  verifyUnlock,
  viewFingerprint,
} from '../src/util.ts'

describe('parseRange', () => {
  it('returns null when the client asked for the whole file', () => {
    assert.equal(parseRange(undefined, 1000), null)
  })

  it('parses a closed range', () => {
    assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499 })
    assert.deepEqual(parseRange('bytes=500-999', 1000), { start: 500, end: 999 })
  })

  it('parses an open-ended range', () => {
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  })

  it('parses a suffix range', () => {
    assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 })
    // A suffix longer than the file is the whole file, not an error.
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
  })

  it('clamps an end past the last byte', () => {
    assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  })

  it('rejects ranges it cannot satisfy', () => {
    assert.equal(parseRange('bytes=1000-1200', 1000), 'unsatisfiable')
    assert.equal(parseRange('bytes=500-100', 1000), 'unsatisfiable')
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable')
    assert.equal(parseRange('bytes=-', 1000), 'unsatisfiable')
    assert.equal(parseRange('kittens=0-10', 1000), 'unsatisfiable')
    // Multi-range is unsupported.
    assert.equal(parseRange('bytes=0-10,20-30', 1000), 'unsatisfiable')
  })
})

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const { hash, salt } = hashPassword('correct horse battery staple')
    assert.equal(verifyPassword('correct horse battery staple', hash, salt), true)
    assert.equal(verifyPassword('Correct horse battery staple', hash, salt), false)
    assert.equal(verifyPassword('', hash, salt), false)
  })

  it('salts, so the same password hashes differently each time', () => {
    assert.notEqual(hashPassword('same').hash, hashPassword('same').hash)
  })
})

describe('unlock cookies', () => {
  const secret = 'test-secret'
  const key = 'a'.repeat(32)

  it('accepts a cookie it signed', () => {
    const token = signUnlock(secret, key, Date.now() + 60_000)
    assert.equal(verifyUnlock(secret, key, token), true)
  })

  it('rejects an expired cookie', () => {
    const token = signUnlock(secret, key, Date.now() - 1)
    assert.equal(verifyUnlock(secret, key, token), false)
  })

  it('rejects a cookie minted for a different recording', () => {
    const token = signUnlock(secret, 'b'.repeat(32), Date.now() + 60_000)
    assert.equal(verifyUnlock(secret, key, token), false)
  })

  it('rejects a tampered expiry', () => {
    const token = signUnlock(secret, key, Date.now() + 60_000)
    const [, , signature] = token.split('.')
    assert.equal(verifyUnlock(secret, key, `${key}.${Date.now() + 9e9}.${signature}`), false)
  })

  it('rejects a cookie signed with another secret', () => {
    assert.equal(
      verifyUnlock(secret, key, signUnlock('other', key, Date.now() + 60_000)),
      false,
    )
  })

  it('rejects nonsense', () => {
    assert.equal(verifyUnlock(secret, key, undefined), false)
    assert.equal(verifyUnlock(secret, key, 'garbage'), false)
  })
})

describe('viewFingerprint', () => {
  it('is stable for the same viewer on the same day', () => {
    const a = viewFingerprint('s', '1.2.3.4', 'UA', '2026-08-02')
    const b = viewFingerprint('s', '1.2.3.4', 'UA', '2026-08-02')
    assert.equal(a, b)
  })

  it('rotates daily and differs per viewer', () => {
    const base = viewFingerprint('s', '1.2.3.4', 'UA', '2026-08-02')
    assert.notEqual(base, viewFingerprint('s', '1.2.3.4', 'UA', '2026-08-03'))
    assert.notEqual(base, viewFingerprint('s', '5.6.7.8', 'UA', '2026-08-02'))
  })

  it('does not contain the address it was derived from', () => {
    assert.doesNotMatch(viewFingerprint('s', '1.2.3.4', 'UA', '2026-08-02'), /1\.2\.3\.4/)
  })
})

describe('parseUploadMetadata', () => {
  it('decodes tus base64 pairs', () => {
    const header = `title ${Buffer.from('Sprint demo').toString('base64')},allowDownload ZmFsc2U=`
    assert.deepEqual(parseUploadMetadata(header), {
      title: 'Sprint demo',
      allowDownload: 'false',
    })
  })

  it('handles valueless keys and an absent header', () => {
    assert.deepEqual(parseUploadMetadata('flag'), { flag: '' })
    assert.deepEqual(parseUploadMetadata(undefined), {})
  })
})

describe('share server', () => {
  let dir: string
  let store: Store
  let server: Server
  let base: string
  const token = 'test-upload-token'

  const auth = { Authorization: `Bearer ${token}` }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'butterfly-share-'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'media'), { recursive: true })

    store = new Store(join(dir, 'test.db'))

    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      mediaDir: join(dir, 'media'),
      databasePath: join(dir, 'test.db'),
      publicUrl: 'http://127.0.0.1',
      uploadToken: token,
      cookieSecret: 'cookie-secret',
      maxUploadBytes: 10 * 1024 * 1024,
    }

    const handler = createHandler({ config, store })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('no port')
    base = `http://127.0.0.1:${address.port}`
    config.publicUrl = base
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const meta = (pairs: Record<string, string>) =>
    Object.entries(pairs)
      .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
      .join(',')

  async function createUpload(extra: Record<string, string> = {}) {
    const response = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: {
        ...auth,
        'Tus-Resumable': '1.0.0',
        'Upload-Defer-Length': '1',
        'Upload-Metadata': meta({ title: 'Sprint demo', ...extra }),
      },
    })
    assert.equal(response.status, 201)
    return (await response.json()) as { shareKey: string; shareUrl: string; uploadUrl: string }
  }

  it('rejects an upload with no token', async () => {
    const response = await fetch(`${base}/v1/uploads`, { method: 'POST' })
    assert.equal(response.status, 401)
  })

  it('mints a share link before a single byte is uploaded', async () => {
    const created = await createUpload()
    assert.match(created.shareKey, /^[0-9a-f]{32}$/)
    assert.equal(created.shareUrl, `${base}/v/${created.shareKey}`)

    const page = await fetch(created.shareUrl)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /still being uploaded/)
  })

  it('completes a chunked resumable upload and serves it back', async () => {
    const created = await createUpload()
    const payload = Buffer.from('BUTTERFLY'.repeat(2000)) // 18,000 bytes

    // Two PATCHes, the second declaring the now-known total length.
    const first = payload.subarray(0, 8000)
    const second = payload.subarray(8000)

    const one = await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0' },
      body: first,
    })
    assert.equal(one.status, 204)
    assert.equal(one.headers.get('upload-offset'), '8000')

    const head = await fetch(created.uploadUrl, { method: 'HEAD', headers: auth })
    assert.equal(head.headers.get('upload-offset'), '8000')
    assert.equal(head.headers.get('upload-defer-length'), '1')

    const two = await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: {
        ...auth,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '8000',
        'Upload-Length': String(payload.length),
      },
      body: second,
    })
    assert.equal(two.status, 204)
    assert.equal(two.headers.get('upload-offset'), String(payload.length))

    const whole = await fetch(`${base}/media/${created.shareKey}`)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(Buffer.from(await whole.arrayBuffer()).equals(payload), true)
  })

  it('rejects a PATCH at the wrong offset instead of corrupting the file', async () => {
    const created = await createUpload()
    await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': '0' },
      body: Buffer.from('abcdef'),
    })

    const conflict = await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': '999' },
      body: Buffer.from('xyz'),
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.headers.get('upload-offset'), '6')
  })

  it('serves byte ranges, which is what makes the scrubber work', async () => {
    const created = await createUpload()
    const payload = Buffer.from('0123456789'.repeat(100)) // 1000 bytes
    await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': '0', 'Upload-Length': String(payload.length) },
      body: payload,
    })

    const ranged = await fetch(`${base}/media/${created.shareKey}`, {
      headers: { Range: 'bytes=10-19' },
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/1000')
    assert.equal(ranged.headers.get('content-length'), '10')
    assert.equal(await ranged.text(), '0123456789')

    const bad = await fetch(`${base}/media/${created.shareKey}`, {
      headers: { Range: 'bytes=5000-6000' },
    })
    assert.equal(bad.status, 416)
    assert.equal(bad.headers.get('content-range'), 'bytes */1000')
  })

  it('counts a viewer once per day however many range requests they make', async () => {
    const created = await createUpload()
    await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': '0', 'Upload-Length': '10' },
      body: Buffer.from('0123456789'),
    })

    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/media/${created.shareKey}`, { headers: { Range: 'bytes=0-4' } })
    }

    assert.equal(store.get(created.shareKey)?.views, 1)
    assert.equal(store.get(created.shareKey)?.watches, 0)

    await fetch(`${base}/v1/beacon/${created.shareKey}`, { method: 'POST' })
    assert.equal(store.get(created.shareKey)?.watches, 1)

    // A second beacon must not double-count.
    await fetch(`${base}/v1/beacon/${created.shareKey}`, { method: 'POST' })
    assert.equal(store.get(created.shareKey)?.watches, 1)
  })

  it('gates a password-protected recording and unlocks with the right one', async () => {
    const created = await createUpload({ password: 'hunter2' })
    await fetch(created.uploadUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Upload-Offset': '0', 'Upload-Length': '5' },
      body: Buffer.from('bytes'),
    })

    const locked = await fetch(created.shareUrl)
    assert.match(await locked.text(), /This recording is protected/)

    // The media must be gated, not just the page.
    assert.equal((await fetch(`${base}/media/${created.shareKey}`)).status, 403)

    const wrong = await fetch(`${created.shareUrl}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
      redirect: 'manual',
    })
    assert.match(await wrong.text(), /did not work/)

    const right = await fetch(`${created.shareUrl}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2',
      redirect: 'manual',
    })
    assert.equal(right.status, 302)
    const cookie = right.headers.getSetCookie()[0]!
    assert.match(cookie, /HttpOnly/)

    const unlocked = await fetch(created.shareUrl, { headers: { Cookie: cookie.split(';')[0]! } })
    assert.match(await unlocked.text(), /<video/)
  })

  it('treats an expired link as one that never existed', async () => {
    const created = await createUpload({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    assert.equal((await fetch(created.shareUrl)).status, 404)
    assert.equal((await fetch(`${base}/media/${created.shareKey}`)).status, 404)
  })

  it('advertises the tus capabilities a client negotiates against', async () => {
    const response = await fetch(`${base}/v1/uploads`, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('tus-version'), '1.0.0')
    assert.match(response.headers.get('tus-extension') ?? '', /creation-defer-length/)
  })

  it('returns oEmbed so Slack and Notion unfurl without an integration', async () => {
    const created = await createUpload()
    await fetch(`${created.uploadUrl}/meta`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Checkout walkthrough', duration: 252, finalize: true }),
    })

    const response = await fetch(
      `${base}/v1/oembed?url=${encodeURIComponent(created.shareUrl)}`,
    )
    assert.equal(response.status, 200)
    const payload = (await response.json()) as Record<string, unknown>
    assert.equal(payload.type, 'video')
    assert.equal(payload.title, 'Checkout walkthrough')
    assert.match(String(payload.html), /<iframe/)
  })

  it('404s an unknown or malformed share key', async () => {
    assert.equal((await fetch(`${base}/v/${'0'.repeat(32)}`)).status, 404)
    assert.equal((await fetch(`${base}/v/not-a-key`)).status, 404)
  })

  it('answers a health check', async () => {
    const response = await fetch(`${base}/healthz`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  })
})
