import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { encodeShareMetadata } from '../src/share-client.ts'

/** Mirrors the server-side Upload-Metadata decoder. */
function decode(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ')
    if (!key) continue
    out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : ''
  }
  return out
}

describe('encodeShareMetadata', () => {
  it('round-trips through the server decoder', () => {
    const header = encodeShareMetadata({
      id: '01J0000000000000000000000A',
      title: 'Sprint demo',
      duration: 252.5,
      width: 1920,
      height: 1080,
    })
    assert.deepEqual(decode(header), {
      id: '01J0000000000000000000000A',
      title: 'Sprint demo',
      duration: '252.5',
      width: '1920',
      height: '1080',
    })
  })

  it('survives titles that are not ASCII', () => {
    // btoa() throws above U+00FF, so values must be encoded as UTF-8 bytes first.
    const header = encodeShareMetadata({ id: 'x', title: 'Café — 日本語 𝄞' })
    assert.equal(decode(header).title, 'Café — 日本語 𝄞')
  })

  it('omits optional fields rather than sending empty ones', () => {
    const decoded = decode(encodeShareMetadata({ id: 'x', title: 'y' }))
    assert.deepEqual(Object.keys(decoded).sort(), ['id', 'title'])
  })

  it('only sends allowDownload when it is being turned off', () => {
    assert.equal(decode(encodeShareMetadata({ id: 'x', title: 'y' })).allowDownload, undefined)
    assert.equal(
      decode(encodeShareMetadata({ id: 'x', title: 'y', allowDownload: true })).allowDownload,
      undefined,
    )
    assert.equal(
      decode(encodeShareMetadata({ id: 'x', title: 'y', allowDownload: false })).allowDownload,
      'false',
    )
  })

  it('carries a password through unmangled', () => {
    const password = 'p@ss word,with spaces'
    assert.equal(
      decode(encodeShareMetadata({ id: 'x', title: 'y', password })).password,
      password,
    )
  })
})
