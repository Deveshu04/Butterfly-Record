// Re-encodes a mid-GOP segment head into a keyframe-led run for frame-exact cuts.
// Splicing is safe only where frames carry their own headers (VP8/VP9 in WebM);
// H.264 and AV1 keep parameter sets out of band. The caller decides which codecs to splice.

import { EncodedPacket, VideoSampleSink, type InputVideoTrack } from 'mediabunny'

export interface BoundaryGop {
  /**
   * Packets on the SOURCE timeline, in presentation order, keyframe first.
   * Empty when the range held no frames.
   */
  packets: EncodedPacket[]
  /** The encoder's config; send this, not the source's, with the first output packet. */
  decoderConfig: VideoDecoderConfig | null
}

export interface ReencodeOptions {
  /** Target bits/sec for the re-encoded frames. */
  bitrate: number
  signal?: AbortSignal
}

/** Bounded because a dozen uncompressed 4K frames is already hundreds of megabytes. */
const MAX_QUEUE_SIZE = 6

/** Below this the output is unusable regardless of the source. */
const MIN_BITRATE = 250_000

/**
 * Decodes `[from, to)` and re-encodes it as a keyframe-led run. Rejects instead of
 * returning a bad result; callers fall back to a keyframe-aligned cut.
 */
export async function reencodeRange(
  track: InputVideoTrack,
  from: number,
  to: number,
  options: ReencodeOptions,
): Promise<BoundaryGop> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs video encoder.')
  }
  if (!(to > from)) {
    return { packets: [], decoderConfig: null }
  }

  const sourceConfig = await track.getDecoderConfig()
  if (!sourceConfig) throw new Error('The source video track has no decoder configuration.')

  // Coded, not display, dimensions: display size may include rotation or pixel aspect ratio.
  const width = sourceConfig.codedWidth ?? track.codedWidth
  const height = sourceConfig.codedHeight ?? track.codedHeight
  if (!(width > 0) || !(height > 0)) {
    throw new Error('The source video track has no usable coded dimensions.')
  }

  const config: VideoEncoderConfig = {
    codec: sourceConfig.codec,
    width,
    height,
    bitrate: Math.max(MIN_BITRATE, Math.round(options.bitrate)),
    // These frames sit next to the original encode, so favour quality over latency.
    latencyMode: 'quality',
  }

  // Decode support does not imply encode support, and hardware encoders vary by machine.
  const support = await VideoEncoder.isConfigSupported(config)
  if (!support.supported) {
    throw new Error(`This browser cannot re-encode ${config.codec} at ${width}x${height}.`)
  }

  const packets: EncodedPacket[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  let failure: Error | null = null

  // Encoder errors arrive on a callback, so drain waiters are woken there too;
  // otherwise a dead encoder hangs on a 'dequeue' event that never comes.
  const waiters = new Set<() => void>()
  const wake = (): void => {
    for (const waiter of waiters) waiter()
    waiters.clear()
  }

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      decoderConfig ??= metadata?.decoderConfig ?? null
      packets.push(EncodedPacket.fromEncodedChunk(chunk))
    },
    error: (cause) => {
      failure ??= toError(cause)
      wake()
    },
  })
  encoder.configure(config)

  const sink = new VideoSampleSink(track)
  let encoded = 0

  try {
    // The sink decodes from the preceding keyframe but yields from `from`, so
    // mid-GOP frames arrive fully reconstructed.
    for await (const sample of sink.samples(from, to)) {
      try {
        if (failure) throw failure
        throwIfAborted(options.signal)

        if (sample.codedWidth !== width || sample.codedHeight !== height) {
          // The output track declares one size, so a mid-segment change cannot be spliced.
          throw new Error('The source video changes resolution inside this segment.')
        }

        await waitForQueue(encoder, waiters)

        // The frame has its own lifetime; close it and the sample, or decoding stalls.
        const frame = sample.toVideoFrame()
        try {
          encoder.encode(frame, { keyFrame: encoded === 0 })
        } finally {
          frame.close()
        }
        encoded++
      } finally {
        sample.close()
      }
    }

    await encoder.flush()
    if (failure) throw failure
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }

  if (packets.length > 0 && packets[0]!.type !== 'key') {
    // keyFrame: true is only a request; a splice opening on a delta frame would corrupt.
    throw new Error('The encoder did not start the re-encoded range with a keyframe.')
  }

  assertSpliceable(sourceConfig, decoderConfig, width, height)

  return { packets, decoderConfig }
}

/** Both bitstreams share one track declaration, so codec and coded size must match. */
function assertSpliceable(
  source: VideoDecoderConfig,
  produced: VideoDecoderConfig | null,
  width: number,
  height: number,
): void {
  if (!produced) return

  if (codecFamily(produced.codec) !== codecFamily(source.codec)) {
    throw new Error(
      `The encoder produced ${produced.codec}, which cannot be spliced into a ${source.codec} track.`,
    )
  }

  const producedWidth = produced.codedWidth ?? width
  const producedHeight = produced.codedHeight ?? height
  if (producedWidth !== width || producedHeight !== height) {
    throw new Error(
      `The encoder produced ${producedWidth}x${producedHeight}, not ${width}x${height}.`,
    )
  }
}

/**
 * Profile and level may differ (WebM does not record them for VP8/VP9); the codec may not.
 * Aliases exist because a decoder config may say 'vp9' where an encoder says 'vp09.00.10.08'.
 */
function codecFamily(codec: string): string {
  const family = codec.toLowerCase().split('.')[0] ?? ''
  if (family === 'vp9') return 'vp09'
  if (family === 'vp8') return 'vp08'
  if (family === 'av1') return 'av01'
  if (family === 'h264' || family === 'avc') return 'avc1'
  if (family === 'h265' || family === 'hevc') return 'hvc1'
  return family
}

/** Resolves when the encoder has room, or as soon as it can no longer make any. */
function waitForQueue(encoder: VideoEncoder, waiters: Set<() => void>): Promise<void> {
  if (encoder.encodeQueueSize <= MAX_QUEUE_SIZE) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const settle = (): void => {
      waiters.delete(settle)
      encoder.removeEventListener('dequeue', check)
      resolve()
    }
    const check = (): void => {
      if (encoder.state !== 'configured' || encoder.encodeQueueSize <= MAX_QUEUE_SIZE) settle()
    }
    waiters.add(settle)
    encoder.addEventListener('dequeue', check)
    check()
  })
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason: unknown = signal.reason
  throw reason instanceof Error ? reason : new Error('Export cancelled.')
}
