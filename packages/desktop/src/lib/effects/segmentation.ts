// Keeps the segmentation model in a worker and feeds it frames only while it is idle, so the
// drawing never waits for it: each frame is drawn with the newest mask there is.

import type { SegmentReply, SegmentRequest } from '../workers/segment-protocol.ts'
import type { Delegate } from './segmenter.ts'

/**
 * In order of preference. The CPU comes first: on integrated graphics the GPU delegate's
 * first start compiles its shaders for many seconds, and while it does the browser's GPU
 * process draws nothing, which freezes every window of the app, the overlay included.
 */
const DELEGATES: readonly Delegate[] = ['CPU', 'GPU']

export interface Mask {
  values: Float32Array
  width: number
  height: number
}

export class Segmentation {
  /** Settles once the model has run once, or once it cannot run at all. */
  readonly ready: Promise<void>
  #onMask: (mask: Mask) => void
  #worker: Worker | null = null
  #delegate: Delegate | null = null
  #attempt = 0
  #running = false
  #busy = false
  #failure: string | null = null
  #resolve: () => void = () => {}
  #reject: (error: Error) => void = () => {}

  constructor(onMask: (mask: Mask) => void) {
    this.#onMask = onMask
    this.ready = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    // Whoever waits sees the failure; nobody waiting is not an error of its own.
    this.ready.catch(() => {})
    this.#spawn()
  }

  /** Why the model cannot run on either the CPU or the GPU. */
  get failure(): string | null {
    return this.#failure
  }

  /** The model is running and has no frame in hand. */
  get idle(): boolean {
    return this.#running && !this.#busy
  }

  /** Takes ownership of `image`, which is dropped unless the model is idle. */
  send(image: ImageBitmap): void {
    if (!this.#worker || !this.idle) {
      image.close()
      return
    }
    this.#busy = true
    this.#worker.postMessage({ type: 'segment', image } satisfies SegmentRequest, [image])
  }

  close(): void {
    this.#terminate()
    this.#reject(new Error('Segmentation was stopped.'))
  }

  #terminate(): void {
    this.#worker?.terminate()
    this.#worker = null
    this.#running = false
  }

  #spawn(): void {
    const delegate = DELEGATES[this.#attempt]
    if (!delegate) return
    const worker = new Worker(new URL('../workers/segment-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('message', (event: MessageEvent<SegmentReply>) => {
      if (worker === this.#worker) this.#reply(event.data)
    })
    worker.addEventListener('error', (event) => {
      event.preventDefault()
      if (worker === this.#worker) this.#fail(event.message || 'The segmentation worker stopped.')
    })
    this.#worker = worker
    this.#delegate = delegate
    worker.postMessage({ type: 'start', delegate } satisfies SegmentRequest)
  }

  #reply(reply: SegmentReply): void {
    if (reply.type === 'failed') {
      this.#fail(reply.message)
    } else if (reply.type === 'ready') {
      this.#running = true
      this.#busy = false
      this.#resolve()
    } else {
      this.#busy = false
      const { values, width, height } = reply
      if (values) this.#onMask({ values, width, height })
    }
  }

  /** Each delegate gives way to the next; when the last fails too, there is nothing left to try. */
  #fail(message: string): void {
    const where = this.#delegate ?? 'device'
    console.warn(`[butterfly-record] segmentation on the ${where} failed: ${message}`)
    this.#terminate()
    this.#attempt += 1
    if (this.#attempt < DELEGATES.length) {
      this.#spawn()
      return
    }
    this.#failure = message
    this.#reject(new Error(message))
  }
}
