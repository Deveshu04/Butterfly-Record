import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { readJson, writeFile, writeJson } from '../src/opfs.ts'

// A minimal in-memory OPFS: writes go to a swap copy that only close() commits.
let failWrites = false

class FakeFileHandle {
  readonly kind = 'file'
  contents = ''

  async getFile(): Promise<File> {
    return new File([this.contents], 'file')
  }

  async createWritable() {
    let swap = ''
    return {
      write: async (data: Blob | string) => {
        if (failWrites) throw new DOMException('The disk is full.', 'QuotaExceededError')
        swap += typeof data === 'string' ? data : await data.text()
      },
      close: async () => {
        this.contents = swap
      },
      abort: async () => {},
    }
  }
}

class FakeDirectory {
  readonly kind = 'directory'
  readonly entries = new Map<string, FakeDirectory | FakeFileHandle>()

  async getDirectoryHandle(name: string, { create = false } = {}): Promise<FakeDirectory> {
    return this.entry(name, create, FakeDirectory)
  }

  async getFileHandle(name: string, { create = false } = {}): Promise<FakeFileHandle> {
    return this.entry(name, create, FakeFileHandle)
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name)) throw new DOMException(name, 'NotFoundError')
  }

  private entry<T extends FakeDirectory | FakeFileHandle>(
    name: string,
    create: boolean,
    Kind: new () => T,
  ): T {
    const found = this.entries.get(name)
    if (found instanceof Kind) return found
    if (found) throw new DOMException(name, 'TypeMismatchError')
    if (!create) throw new DOMException(name, 'NotFoundError')
    const made = new Kind()
    this.entries.set(name, made)
    return made
  }
}

let root = new FakeDirectory()
Object.defineProperty(globalThis.navigator, 'storage', {
  configurable: true,
  value: { getDirectory: async () => root },
})

const path = ['sessions', 'id', 'edl.json']

describe('writeFile', () => {
  beforeEach(() => {
    root = new FakeDirectory()
    failWrites = false
  })

  it('leaves no file behind when the first write fails', async () => {
    failWrites = true
    await assert.rejects(writeJson(path, { cut: 1 }), { name: 'QuotaExceededError' })
    failWrites = false
    assert.equal(await readJson(path), null)
    const dir = await (await root.getDirectoryHandle('sessions')).getDirectoryHandle('id')
    assert.equal(dir.entries.has('edl.json'), false)
  })

  it('keeps the previous contents when an overwrite fails', async () => {
    await writeJson(path, { cut: 1 })
    failWrites = true
    await assert.rejects(writeFile(path, '{"cut":2}'), { name: 'QuotaExceededError' })
    failWrites = false
    assert.deepEqual(await readJson(path), { cut: 1 })
  })
})

describe('readJson', () => {
  beforeEach(() => {
    root = new FakeDirectory()
    failWrites = false
  })

  it('treats an empty file as missing', async () => {
    const sessions = await root.getDirectoryHandle('sessions', { create: true })
    const dir = await sessions.getDirectoryHandle('id', { create: true })
    await dir.getFileHandle('edl.json', { create: true })
    assert.equal(await readJson(path), null)
  })

  it('still reports a file with unreadable contents', async () => {
    await writeFile(path, '{"cut":')
    await assert.rejects(readJson(path), SyntaxError)
  })
})
