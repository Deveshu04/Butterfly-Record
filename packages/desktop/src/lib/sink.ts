// The recorder's chunk sink: MediaRecorder output appended to <session>\source.part by Rust.

import { SinkFullError, type ChunkSink } from '@butterfly-record/core'

import { isIpcError, recAbort, recClose, recFlush, recOpen, recWrite } from './ipc.ts'

export class RustChunkSink implements ChunkSink {
  readonly #id: string
  #bytesWritten = 0
  #closed = false

  private constructor(id: string) {
    this.#id = id
  }

  static async open(sessionId: string): Promise<RustChunkSink> {
    await recOpen(sessionId)
    return new RustChunkSink(sessionId)
  }

  get bytesWritten(): number {
    return this.#bytesWritten
  }

  async write(bytes: ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error('The recording file is already closed.')
    try {
      this.#bytesWritten = await recWrite(this.#id, new Uint8Array(bytes))
    } catch (error) {
      if (isIpcError(error) && error.code === 'disk_full') {
        throw new SinkFullError(this.#bytesWritten)
      }
      throw error
    }
  }

  async flush(): Promise<void> {
    if (this.#closed) return
    await recFlush(this.#id)
  }

  async close(): Promise<number> {
    if (this.#closed) return this.#bytesWritten
    this.#closed = true
    this.#bytesWritten = await recClose(this.#id)
    return this.#bytesWritten
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await recAbort(this.#id)
  }
}
