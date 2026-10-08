// Min/max audio envelope for the editor waveform. Treated as a cache: a missing
// peaks.json is always a valid state and is rebuilt on demand.

import { PEAKS_FILE, readJson, sessionPath, writeJson } from './opfs.ts'

export const PEAKS_SCHEMA = 1

/** Buckets per second of source: 25 ms each, enough to separate words at high zoom. */
export const DEFAULT_BUCKETS_PER_SECOND = 40

/** Above this the envelope stops being a meaningful reduction of the signal. */
const MAX_BUCKETS_PER_SECOND = 1000

export interface Peaks {
  schema: typeof PEAKS_SCHEMA
  /** Buckets per second of source. */
  resolution: number
  duration: number
  /** Interleaved min,max pairs in -1..1, two entries per bucket. */
  data: number[]
}

export interface GeneratePeaksOptions {
  /** Buckets per second. Defaults to DEFAULT_BUCKETS_PER_SECOND. */
  resolution?: number
  /** 0..1. Fires once per decoded packet; throttle before putting it on screen. */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

export function bucketCount(peaks: Peaks): number {
  return Math.floor(peaks.data.length / 2)
}

/** A silent envelope: no buckets, which `resample` draws as a flat line. */
export function emptyPeaks(duration: number, resolution = DEFAULT_BUCKETS_PER_SECOND): Peaks {
  return {
    schema: PEAKS_SCHEMA,
    resolution,
    duration: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    data: [],
  }
}

/** Shape check only; entries are not validated, since a bad one misdraws a single column. */
export function isPeaks(value: unknown): value is Peaks {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Peaks>
  return (
    candidate.schema === PEAKS_SCHEMA &&
    typeof candidate.resolution === 'number' &&
    candidate.resolution > 0 &&
    typeof candidate.duration === 'number' &&
    Number.isFinite(candidate.duration) &&
    Array.isArray(candidate.data) &&
    candidate.data.length % 2 === 0
  )
}

/** Streams the audio into buckets so PCM is never held in memory (about 1.1 MB per hour). */
export async function generatePeaks(
  file: File,
  options: GeneratePeaksOptions = {},
): Promise<Peaks> {
  const resolution = resolutionFrom(options.resolution)

  // Lazy import: a cache hit never loads the demuxer, and the pure reducers stay
  // testable outside a browser.
  const [{ ALL_FORMATS, AudioSampleSink, Input }, { sourceForFile }] = await Promise.all([
    import('mediabunny'),
    import('./source.ts'),
  ])

  const input = new Input({ source: sourceForFile(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryAudioTrack()
  const duration = await input.computeDuration()

  // A recording without audio is normal: silence, not an error.
  if (!track) return emptyPeaks(duration, resolution)

  const count = Math.ceil(duration * resolution)
  if (!(count > 0)) return emptyPeaks(duration, resolution)

  // Zero-initialised: an unreached bucket reads as silence, and a bucket entirely
  // above the axis reports a min of 0.
  const mins = new Float32Array(count)
  const maxs = new Float32Array(count)

  const sink = new AudioSampleSink(track)
  for await (const sample of sink.samples()) {
    options.signal?.throwIfAborted()

    const channels = sample.numberOfChannels
    const frames = sample.numberOfFrames
    const rate = sample.sampleRate
    const timestamp = sample.timestamp

    // 'f32' is interleaved, so a frame's channels are adjacent.
    const planar = new Float32Array(frames * channels)
    sample.copyTo(planar, { planeIndex: 0, format: 'f32' })

    for (let frame = 0; frame < frames; frame++) {
      const bucket = Math.floor((timestamp + frame / rate) * resolution)
      if (bucket < 0 || bucket >= count) continue

      // Downmixed by averaging; antiphase channels cancel, as they do for the listener.
      let sum = 0
      for (let channel = 0; channel < channels; channel++) {
        sum += planar[frame * channels + channel] ?? 0
      }
      const value = sum / channels

      if (value < mins[bucket]!) mins[bucket] = value
      if (value > maxs[bucket]!) maxs[bucket] = value
    }

    sample.close()
    options.onProgress?.(Math.min(1, (timestamp + frames / rate) / duration))
  }

  return { schema: PEAKS_SCHEMA, resolution, duration, data: interleave(mins, maxs) }
}

/** Rounded to three decimals to keep the JSON small; well below one pixel of precision. */
function interleave(mins: Float32Array, maxs: Float32Array): number[] {
  const data = new Array<number>(mins.length * 2)
  for (let i = 0; i < mins.length; i++) {
    data[i * 2] = round(mins[i]!)
    data[i * 2 + 1] = round(maxs[i]!)
  }
  return data
}

function round(value: number): number {
  // Float PCM can exceed -1..1; renderers rely on the documented range.
  const clamped = Math.max(-1, Math.min(1, value))
  return Math.round(clamped * 1000) / 1000
}

function resolutionFrom(resolution: number | undefined): number {
  if (resolution === undefined || !Number.isFinite(resolution) || resolution <= 0) {
    return DEFAULT_BUCKETS_PER_SECOND
  }
  return Math.min(MAX_BUCKETS_PER_SECOND, Math.round(resolution))
}

export async function readPeaks(id: string): Promise<Peaks | null> {
  const stored = await readJson<unknown>(sessionPath(id, PEAKS_FILE))
  return isPeaks(stored) ? stored : null
}

export async function writePeaks(id: string, peaks: Peaks): Promise<void> {
  await writeJson(sessionPath(id, PEAKS_FILE), peaks)
}

/**
 * Read-through cache. Resolves null when the audio cannot be decoded, so the editor
 * still opens; an abort is re-thrown so the caller can tell it from a failure.
 */
export async function ensurePeaks(
  id: string,
  file: File,
  options: GeneratePeaksOptions = {},
): Promise<Peaks | null> {
  const cached = await readPeaks(id)
  if (cached !== null) {
    if (options.resolution === undefined) return cached
    if (cached.resolution === resolutionFrom(options.resolution)) return cached
  }

  let peaks: Peaks
  try {
    peaks = await generatePeaks(file, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    console.warn('[butterfly-record] could not build a waveform', error)
    return null
  }

  try {
    await writePeaks(id, peaks)
  } catch (error) {
    // Most likely out of quota; the envelope is still usable for this session.
    console.warn('[butterfly-record] could not cache the waveform', error)
  }

  return peaks
}

/**
 * Reduces the envelope to `width` columns of interleaved min,max pairs. A column takes the
 * extremes of its buckets (averaging hides transients); zoomed in, a bucket is held across
 * columns, not interpolated. Width <= 0, as from an unlaid-out canvas, yields an empty array.
 */
export function resample(
  peaks: Peaks,
  width: number,
  from = 0,
  to = peaks.duration,
): Float32Array {
  const columns = Math.floor(width)
  if (!Number.isFinite(columns) || columns <= 0) return new Float32Array(0)

  const out = new Float32Array(columns * 2)
  const count = bucketCount(peaks)
  if (count === 0) return out

  // A right-to-left drag reverses the range, and zoom arithmetic overshoots the ends.
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(peaks.duration, Math.max(from, to))
  if (!(hi > lo)) return out

  const first = lo * peaks.resolution
  const span = (hi * peaks.resolution - first) / columns

  for (let column = 0; column < columns; column++) {
    const start = first + span * column
    // Half-open [start, end). max() makes a column narrower than a bucket read that bucket.
    const startBucket = Math.floor(start)
    const endBucket = Math.max(startBucket, Math.ceil(start + span) - 1)

    // Columns past the decoded buckets stay silent rather than smearing the last bucket.
    if (endBucket < 0 || startBucket >= count) continue

    let min = 0
    let max = 0
    for (let bucket = Math.max(0, startBucket); bucket <= Math.min(count - 1, endBucket); bucket++) {
      const bucketMin = peaks.data[bucket * 2] ?? 0
      const bucketMax = peaks.data[bucket * 2 + 1] ?? 0
      if (bucketMin < min) min = bucketMin
      if (bucketMax > max) max = bucketMax
    }

    out[column * 2] = min
    out[column * 2 + 1] = max
  }

  return out
}

/**
 * Per-column amplitude 0..1 for mirrored bars: the larger excursion, since (max - min) / 2
 * under-draws asymmetric transients.
 */
export function envelopeFor(
  peaks: Peaks,
  width: number,
  from = 0,
  to = peaks.duration,
): Float32Array {
  const pairs = resample(peaks, width, from, to)
  const out = new Float32Array(pairs.length / 2)
  for (let column = 0; column < out.length; column++) {
    const min = Math.abs(pairs[column * 2] ?? 0)
    const max = Math.abs(pairs[column * 2 + 1] ?? 0)
    // Also clamped here for envelopes written before generation clamped.
    out[column] = Math.min(1, Math.max(min, max))
  }
  return out
}
