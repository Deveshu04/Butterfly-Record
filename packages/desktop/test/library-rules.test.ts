import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { InsufficientSpaceError } from '@butterfly-record/core/library'

import type { DesktopManifest, LibraryItem } from '../src/lib/ipc.ts'
import { ImportError, checkFinalizeSpace, leftoverParts } from '../src/lib/library-rules.ts'

const GB = 1024 ** 3

describe('checkFinalizeSpace', () => {
  it('allows a finalize when the copy fits with headroom', () => {
    assert.doesNotThrow(() => checkFinalizeSpace(4 * GB, 4.5 * GB))
  })

  it('refuses before writing when the copy would fill the disk', () => {
    assert.throws(
      () => checkFinalizeSpace(4 * GB, 4.2 * GB),
      (error: unknown) =>
        error instanceof InsufficientSpaceError &&
        error.required === Math.ceil(4 * GB * 1.1) &&
        error.available === 4.2 * GB &&
        /recover it from the library/.test(error.message),
    )
  })

  it('does not block when the free space is unknown', () => {
    assert.doesNotThrow(() => checkFinalizeSpace(4 * GB, 0))
  })
})

function item(
  id: string,
  options: { media?: boolean; mediaPath?: string | null; partBytes?: number | null },
): LibraryItem {
  const manifest = {
    media: options.media ? { path: `${id}.webm`, external: false } : null,
  } as DesktopManifest
  return {
    id,
    manifest,
    mediaPath: options.mediaPath ?? null,
    mediaBytes: null,
    partBytes: options.partBytes ?? null,
    sidecar: [],
    sessionDir: `D:\\Library\\.butterfly\\${id}`,
  }
}

describe('leftoverParts', () => {
  const idle = () => false

  it('lists finished items that still hold their raw capture', () => {
    const items = [
      item('done', { media: true, mediaPath: 'D:\\Library\\done.webm', partBytes: 5_000 }),
      item('empty-part', { media: true, mediaPath: 'D:\\Library\\e.webm', partBytes: 0 }),
      item('clean', { media: true, mediaPath: 'D:\\Library\\clean.webm' }),
    ]
    assert.deepEqual(leftoverParts(items, idle), ['done', 'empty-part'])
  })

  it('keeps the capture of anything not yet finished or whose file is missing', () => {
    const items = [
      item('recovering', { partBytes: 5_000 }),
      item('file-missing', { media: true, mediaPath: null, partBytes: 5_000 }),
    ]
    assert.deepEqual(leftoverParts(items, idle), [])
  })

  it('leaves items that are being written alone', () => {
    const items = [item('busy', { media: true, mediaPath: 'D:\\Library\\b.webm', partBytes: 1 })]
    assert.deepEqual(leftoverParts(items, (id) => id === 'busy'), [])
  })
})

describe('ImportError', () => {
  const broken = { name: 'broken.mp4', message: 'This file has no video or audio in it.' }

  it('names the file and the reason when one file fails', () => {
    const error = new ImportError([], [broken])
    assert.equal(
      error.message,
      'Could not import broken.mp4: This file has no video or audio in it.',
    )
    assert.deepEqual(error.imported, [])
    assert.deepEqual(error.failed, [broken])
  })

  it('mentions the files that did import', () => {
    assert.equal(
      new ImportError(['a', 'b', 'c'], [broken]).message,
      'Could not import broken.mp4: This file has no video or audio in it. ' +
        'The other 3 files were imported.',
    )
    assert.match(new ImportError(['a'], [broken]).message, / The other file was imported\.$/)
  })

  it('lists several failures and adds the reason when they share one', () => {
    const codec = 'This file uses a codec this PC cannot play.'
    const failed = ['a.mkv', 'b.mkv'].map((name) => ({ name, message: codec }))
    assert.equal(
      new ImportError([], failed).message,
      `Could not import 2 files: a.mkv and b.mkv. ${codec}`,
    )
  })

  it('shortens long lists and leaves out differing reasons', () => {
    const failed = ['1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4'].map((name, index) => ({
      name,
      message: `Reason ${index}`,
    }))
    assert.equal(
      new ImportError([], failed).message,
      'Could not import 5 files: 1.mp4, 2.mp4, 3.mp4 and 2 more.',
    )
  })

  it('ends a reason without punctuation with a full stop', () => {
    const io = { name: 'x.mov', message: 'A file operation failed: Access is denied' }
    assert.equal(
      new ImportError(['a'], [io]).message,
      'Could not import x.mov: A file operation failed: Access is denied. ' +
        'The other file was imported.',
    )
  })
})
