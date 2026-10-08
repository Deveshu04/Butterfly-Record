import type { ChunkSink } from './chunk-sink.ts'
import type { CaptureSurface, FinalizedFields, PauseSpan } from './manifest.ts'

export interface EncodeOptions {
  /** ULID; names the OPFS session directory. */
  sessionId: string
  /** Video track plus at most one already-mixed audio track. */
  stream: MediaStream
  width: number
  height: number
  frameRate: number
  surface: CaptureSurface
  videoBitsPerSecond: number
  audioBitsPerSecond: number
  /** A hint only; never derive elapsed time from chunk counts. */
  timesliceMs?: number
  onFault?: (fault: EncoderFault) => void
  /** Where the raw capture is written. Defaults to the OPFS part file. */
  openSink?: (sessionId: string) => Promise<ChunkSink>
  /** Indexes the closed capture. Defaults to the OPFS remux into source.webm. */
  finalize?: (sessionId: string) => Promise<{ duration: number; bytes: number }>
}

export interface EncoderFault {
  reason: 'disk-full' | 'source-ended' | 'encoder-error'
  message: string
  /** True when the bytes written so far are still a usable recording. */
  recoverable: boolean
}

export type EncoderPhase = 'idle' | 'recording' | 'paused' | 'finalizing' | 'done' | 'cancelled'

export interface Encoder {
  readonly kind: 'media-recorder' | 'webcodecs' | 'native-mf'
  readonly phase: EncoderPhase
  /** Seconds, excluding paused time. */
  readonly elapsed: number
  readonly bytesWritten: number
  readonly pauses: readonly PauseSpan[]
  start(options: EncodeOptions): Promise<void>
  pause(): void
  resume(): void
  /** Also finalizes, so the output is indexed when this resolves. */
  stop(): Promise<FinalizedFields>
  /** Deletes everything written. */
  cancel(): Promise<void>
}

/** Uses performance.now(): the wall clock can jump (NTP, sleep/resume) mid-recording. */
export class Stopwatch {
  #startedAt = 0
  #accumulated = 0
  #running = false

  start(): void {
    this.#startedAt = performance.now()
    this.#accumulated = 0
    this.#running = true
  }

  pause(): void {
    if (!this.#running) return
    this.#accumulated += performance.now() - this.#startedAt
    this.#running = false
  }

  resume(): void {
    if (this.#running) return
    this.#startedAt = performance.now()
    this.#running = true
  }

  /** Seconds. */
  get elapsed(): number {
    const live = this.#running ? performance.now() - this.#startedAt : 0
    return (this.#accumulated + live) / 1000
  }

  stop(): number {
    this.pause()
    return this.#accumulated / 1000
  }
}

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task)
    // Keep one rejection from poisoning the chain; callers still see it via `result`.
    this.#tail = result.catch(() => {})
    return result
  }

  async drain(): Promise<void> {
    await this.#tail
  }
}
