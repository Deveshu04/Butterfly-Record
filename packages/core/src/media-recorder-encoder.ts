// Chunks go straight to the sink (an OPFS file by default), never into an in-memory array,
// so memory stays flat.

import { OpfsChunkSink, SinkFullError, type ChunkSink } from './chunk-sink.ts'
import {
  SerialQueue,
  Stopwatch,
  type EncodeOptions,
  type Encoder,
  type EncoderFault,
  type EncoderPhase,
} from './encoder.ts'
import type { FinalizedFields, PauseSpan } from './manifest.ts'
import { pickRecordingCodec } from './codecs.ts'

const DEFAULT_TIMESLICE_MS = 2000

/** Bounds what an OS crash or power loss can take; sinks otherwise persist only on close. */
const FLUSH_INTERVAL_MS = 10_000

function openOpfsSink(sessionId: string): Promise<ChunkSink> {
  return OpfsChunkSink.open(sessionId)
}

async function finalizeOpfs(sessionId: string): Promise<{ duration: number; bytes: number }> {
  // Lazy import keeps Mediabunny out of memory while recording.
  const { finalizeRecording } = await import('./finalize.ts')
  return finalizeRecording(sessionId)
}

export class MediaRecorderEncoder implements Encoder {
  readonly kind = 'media-recorder' as const

  #phase: EncoderPhase = 'idle'
  #options: EncodeOptions | null = null
  #recorder: MediaRecorder | null = null
  #sink: ChunkSink | null = null
  #videoTrack: MediaStreamTrack | null = null

  readonly #queue = new SerialQueue()
  readonly #watch = new Stopwatch()
  readonly #pauses: PauseSpan[] = []
  #pausedAt: number | null = null

  #flushTimer: ReturnType<typeof setInterval> | null = null
  #flushedBytes = 0

  /** Resolves when MediaRecorder has emitted its final chunk. */
  #stopped: Promise<void> = Promise.resolve()
  #onStopped: () => void = () => {}

  #fault: EncoderFault | null = null
  /** Every ondataavailable, including empty ones, for the diagnosis in stop(). */
  #chunks = 0

  get phase(): EncoderPhase {
    return this.#phase
  }

  get elapsed(): number {
    return this.#watch.elapsed
  }

  get bytesWritten(): number {
    return this.#sink?.bytesWritten ?? 0
  }

  get pauses(): readonly PauseSpan[] {
    return this.#pauses
  }

  async start(options: EncodeOptions): Promise<void> {
    if (this.#phase !== 'idle') throw new Error(`MediaRecorderEncoder: already ${this.#phase}`)

    const [videoTrack] = options.stream.getVideoTracks()
    if (!videoTrack) throw new Error('MediaRecorderEncoder: stream has no video track')

    // MediaRecorder silently records nothing from an ended track, e.g. when a capture
    // stream ID was consumed twice or the sharing prompt was dismissed after granting.
    if (videoTrack.readyState !== 'live') {
      throw new Error(
        'The capture source ended before recording could start. Try selecting it again.',
      )
    }

    const hasAudio = options.stream.getAudioTracks().length > 0
    const codec = pickRecordingCodec(hasAudio)
    const sink = await (options.openSink ?? openOpfsSink)(options.sessionId)

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(options.stream, {
        mimeType: codec.mimeType,
        videoBitsPerSecond: options.videoBitsPerSecond,
        // Chrome can reject an audio bitrate on a stream with no audio.
        ...(hasAudio ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
      })
    } catch (error) {
      await sink.abort().catch(() => {})
      throw error
    }

    console.info(
      `[butterfly-record] recording ${codec.mimeType} · ${options.width}x${options.height}@${options.frameRate} · audio: ${hasAudio}`,
    )

    this.#options = options
    this.#sink = sink
    this.#recorder = recorder
    this.#videoTrack = videoTrack

    this.#stopped = new Promise<void>((resolve) => {
      this.#onStopped = resolve
    })

    recorder.ondataavailable = (event) => {
      this.#chunks++
      if (event.data.size > 0) this.#absorb(event.data)
    }

    recorder.onstop = () => this.#onStopped()

    recorder.onerror = (event) => {
      const error = (event as unknown as { error?: DOMException }).error
      this.#raise({
        reason: 'encoder-error',
        message: error?.message ?? 'MediaRecorder failed',
        // Bytes already written are still a usable recording.
        recoverable: this.bytesWritten > 0,
      })
    }

    // Chrome's own "Stop sharing" button, or the recorded tab closing, ends
    // the track without telling MediaRecorder to stop.
    videoTrack.addEventListener('ended', () => {
      if (this.#phase === 'recording' || this.#phase === 'paused') {
        this.#raise({
          reason: 'source-ended',
          message: 'The capture source stopped.',
          recoverable: true,
        })
      }
    })

    try {
      recorder.start(options.timesliceMs ?? DEFAULT_TIMESLICE_MS)
    } catch (error) {
      this.#options = null
      this.#sink = null
      this.#recorder = null
      this.#videoTrack = null
      await sink.abort().catch(() => {})
      throw error
    }
    this.#watch.start()
    this.#phase = 'recording'
    this.#flushTimer = setInterval(() => this.#flush(), FLUSH_INTERVAL_MS)
  }

  #absorb(blob: Blob): void {
    void this.#queue.run(async () => {
      const buffer = await blob.arrayBuffer()
      try {
        await this.#sink!.write(buffer)
      } catch (error) {
        this.#sinkFailed(error)
      }
    })
  }

  /** Queued behind pending writes, so everything written before it reaches the disk. */
  #flush(): void {
    const sink = this.#sink
    if (!sink || this.#fault || sink.bytesWritten === this.#flushedBytes) return
    void this.#queue.run(async () => {
      const reached = sink.bytesWritten
      try {
        await sink.flush()
        this.#flushedBytes = reached
      } catch (error) {
        this.#sinkFailed(error)
      }
    })
  }

  #stopFlushing(): void {
    if (this.#flushTimer === null) return
    clearInterval(this.#flushTimer)
    this.#flushTimer = null
  }

  #sinkFailed(error: unknown): void {
    if (error instanceof SinkFullError) {
      this.#raise({
        reason: 'disk-full',
        message: 'Ran out of disk space. The recording up to this point was saved.',
        recoverable: true,
      })
      return
    }
    this.#raise({
      reason: 'encoder-error',
      message: error instanceof Error ? error.message : String(error),
      recoverable: this.bytesWritten > 0,
    })
  }

  #raise(fault: EncoderFault): void {
    if (this.#fault) return
    this.#fault = fault
    this.#options?.onFault?.(fault)
    // Only stop the recorder; the owner decides whether to finalize or discard.
    if (this.#recorder && this.#recorder.state !== 'inactive') {
      try {
        this.#recorder.stop()
      } catch {
        /* already stopping */
      }
    }
  }

  pause(): void {
    if (this.#phase !== 'recording' || !this.#recorder) return
    this.#recorder.pause()
    this.#watch.pause()
    this.#pausedAt = this.#watch.elapsed
    this.#phase = 'paused'
  }

  resume(): void {
    if (this.#phase !== 'paused' || !this.#recorder) return
    this.#recorder.resume()
    this.#watch.resume()
    if (this.#pausedAt !== null) {
      this.#pauses.push({ at: this.#pausedAt, resumedAt: this.#watch.elapsed })
      this.#pausedAt = null
    }
    this.#phase = 'recording'
  }

  async stop(): Promise<FinalizedFields> {
    if (this.#phase === 'idle') throw new Error('MediaRecorderEncoder: stop before start')
    if (this.#phase === 'cancelled') throw new Error('MediaRecorderEncoder: already cancelled')

    const { sessionId, finalize = finalizeOpfs } = this.#options!

    this.#stopFlushing()
    if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop()
    this.#watch.stop()
    this.#phase = 'finalizing'

    // onstop fires after the final ondataavailable, so waiting on it and then
    // draining the queue guarantees every byte reached the sink.
    await this.#stopped
    await this.#queue.drain()
    const captured = await this.#sink!.close()

    // Diagnose here: finalize can only report "0 bytes", not whether capture or disk failed.
    if (captured === 0) {
      const detail =
        this.#chunks === 0
          ? `MediaRecorder produced no data in ${this.elapsed.toFixed(1)}s. The capture source was probably not delivering frames.`
          : `${this.#chunks} chunks arrived but nothing reached the disk.`
      throw new Error(`Nothing was recorded. ${detail}`)
    }

    console.info(
      `[butterfly-record] captured ${this.#chunks} chunks, ${captured} bytes in ${this.elapsed.toFixed(1)}s`,
    )

    const { duration, bytes } = await finalize(sessionId)
    this.#phase = 'done'

    return {
      duration,
      bytes,
      // Not computed here: hashing would mean re-reading the whole file.
      sha256: null,
    }
  }

  async cancel(): Promise<void> {
    if (this.#phase === 'cancelled' || this.#phase === 'idle') {
      this.#phase = 'cancelled'
      return
    }

    this.#stopFlushing()
    if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop()
    this.#watch.stop()

    await this.#stopped
    await this.#queue.drain()
    await this.#sink?.abort()
    this.#phase = 'cancelled'
  }

  get fault(): EncoderFault | null {
    return this.#fault
  }

  /** The owner calls this after stop() or cancel(). */
  stopTracks(): void {
    for (const track of this.#options?.stream.getTracks() ?? []) track.stop()
    this.#videoTrack = null
  }
}
