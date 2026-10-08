import { isQuotaExceeded, sessionPath, PART_FILE } from './opfs.ts'
import type { WriterRequest, WriterRequestBody, WriterResponse } from './writer-protocol.ts'

export interface ChunkSink {
  /** The buffer is transferred and must not be reused. */
  write(bytes: ArrayBuffer): Promise<void>
  flush(): Promise<void>
  /** Resolves with the total bytes written. */
  close(): Promise<number>
  /** Closes and deletes the file. */
  abort(): Promise<void>
  readonly bytesWritten: number
}

export class SinkFullError extends Error {
  override readonly name = 'SinkFullError'
  constructor(readonly bytesWritten: number) {
    super('Ran out of disk space while writing the recording.')
  }
}

interface Pending {
  resolve: (bytesWritten: number) => void
  reject: (error: unknown) => void
}

export class OpfsChunkSink implements ChunkSink {
  readonly #worker: Worker
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #bytesWritten = 0
  #closed = false
  /** Set when the worker dies, so later calls reject instead of hanging. */
  #fatal: unknown = null

  private constructor(worker: Worker) {
    this.#worker = worker

    worker.onmessage = (event: MessageEvent<WriterResponse>) => {
      const response = event.data
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)

      this.#bytesWritten = response.bytesWritten
      if (response.type === 'ok') {
        pending.resolve(response.bytesWritten)
        return
      }

      const error =
        response.name === 'QuotaExceededError' || response.name === 'NotAllowedError'
          ? new SinkFullError(response.bytesWritten)
          : Object.assign(new Error(response.message), { name: response.name })
      pending.reject(error)
    }

    worker.onerror = (event) => this.#die(new Error(`writer worker failed: ${event.message}`))
    worker.onmessageerror = () => this.#die(new Error('writer worker received an unreadable message'))
  }

  static async open(sessionId: string): Promise<OpfsChunkSink> {
    const worker = new Worker(new URL('./workers/opfs-writer.ts', import.meta.url), {
      type: 'module',
      name: `butterfly-writer-${sessionId}`,
    })
    const sink = new OpfsChunkSink(worker)
    await sink.#send({ type: 'open', path: sessionPath(sessionId, PART_FILE) })
    return sink
  }

  get bytesWritten(): number {
    return this.#bytesWritten
  }

  #die(error: unknown): void {
    this.#fatal = error
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #send(request: WriterRequestBody, transfer: Transferable[] = []): Promise<number> {
    if (this.#fatal) return Promise.reject(this.#fatal)

    const id = this.#nextId++
    return new Promise<number>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.postMessage({ ...request, id } as WriterRequest, transfer)
    })
  }

  async write(bytes: ArrayBuffer): Promise<void> {
    if (this.#closed) throw new Error('OpfsChunkSink: write after close')
    // Awaiting each write is deliberate backpressure: a slow disk throttles the
    // encoder instead of queueing buffers in memory.
    await this.#send({ type: 'write', buffer: bytes }, [bytes])
  }

  async flush(): Promise<void> {
    if (this.#closed) return
    await this.#send({ type: 'flush' })
  }

  async close(): Promise<number> {
    if (this.#closed) return this.#bytesWritten
    this.#closed = true
    try {
      return await this.#send({ type: 'close' })
    } finally {
      this.#worker.terminate()
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#send({ type: 'abort' })
    } catch {
      // Discarding anyway; the orphan scan collects leftovers.
    } finally {
      this.#worker.terminate()
    }
  }
}

export { isQuotaExceeded }
