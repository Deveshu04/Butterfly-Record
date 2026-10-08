// On-device transcription; audio never leaves the machine.

import { ALL_FORMATS, AudioSampleSink, Input } from 'mediabunny'

import { emptyTranscript, type Transcript, type TranscriptSegment } from './transcript.ts'
import { sourceForFile } from './source.ts'

/** Whisper expects 16 kHz mono. */
export const TARGET_SAMPLE_RATE = 16_000

export interface TranscribeProgress {
  stage: 'decoding' | 'loading-model' | 'transcribing'
  /** 0..1 within the stage, or null if unknown. */
  progress: number | null
  message: string
}

export interface TranscribeOptions {
  /** Hugging Face model id. */
  model?: string
  language?: string
  /**
   * Required in an MV3 extension: ONNX Runtime otherwise fetches its WASM from a
   * CDN, which the extension CSP blocks. The extension passes `chrome.runtime.getURL('/')`.
   */
  wasmPaths?: string
  onProgress?: (progress: TranscribeProgress) => void
  signal?: AbortSignal
}

// Larger quantized Whisper builds are not reliably more accurate than base.
export const DEFAULT_MODEL = 'onnx-community/whisper-base'

/**
 * Streams and downmixes rather than using decodeAudioData, so peak memory is the
 * 16 kHz mono output rather than the full decoded PCM.
 */
export async function extractAudio(
  file: File,
  options: { onProgress?: (progress: number) => void; signal?: AbortSignal } = {},
): Promise<{ samples: Float32Array; duration: number }> {
  const input = new Input({ source: sourceForFile(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryAudioTrack()
  if (!track) throw new Error('This recording has no audio to transcribe.')

  const duration = await input.computeDuration()
  const sink = new AudioSampleSink(track)

  const total = Math.ceil(duration * TARGET_SAMPLE_RATE) + TARGET_SAMPLE_RATE
  const output = new Float32Array(total)
  let written = 0

  for await (const sample of sink.samples()) {
    options.signal?.throwIfAborted()

    const channels = sample.numberOfChannels
    const frames = sample.numberOfFrames
    const rate = sample.sampleRate

    const planar = new Float32Array(frames * channels)
    sample.copyTo(planar, { planeIndex: 0, format: 'f32' })

    // Plain decimation without a low-pass filter; the aliasing does not affect recognition.
    const ratio = rate / TARGET_SAMPLE_RATE
    const outFrames = Math.floor(frames / ratio)

    for (let i = 0; i < outFrames && written < total; i++) {
      const source = Math.floor(i * ratio)
      let sum = 0
      for (let channel = 0; channel < channels; channel++) {
        sum += planar[source * channels + channel] ?? 0
      }
      output[written++] = sum / channels
    }

    sample.close()
    if (duration > 0) options.onProgress?.(Math.min(1, written / TARGET_SAMPLE_RATE / duration))
  }

  return { samples: output.subarray(0, written), duration }
}

interface WhisperChunk {
  text: string
  timestamp: [number, number | null]
}

interface WhisperResult {
  text: string
  chunks?: WhisperChunk[]
}

export async function transcribeAudio(
  samples: Float32Array,
  duration: number,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const model = options.model ?? DEFAULT_MODEL

  options.onProgress?.({
    stage: 'loading-model',
    progress: null,
    message: 'Downloading the speech model (first run only)…',
  })

  const { env, pipeline } = await import('@huggingface/transformers')

  if (options.wasmPaths) env.backends.onnx.wasm!.wasmPaths = options.wasmPaths

  const recognizer = await pipeline('automatic-speech-recognition', model, {
    // The library falls back to WASM when no WebGPU adapter is available.
    device: 'webgpu',
    dtype: 'q8',
    progress_callback: (event: { status?: string; progress?: number }) => {
      if (event.status !== 'progress') return
      options.onProgress?.({
        stage: 'loading-model',
        progress: typeof event.progress === 'number' ? event.progress / 100 : null,
        message: 'Downloading the speech model (first run only)…',
      })
    },
  })

  options.signal?.throwIfAborted()
  options.onProgress?.({ stage: 'transcribing', progress: 0, message: 'Transcribing…' })

  const result = (await recognizer(samples, {
    // Whisper's window is 30 s; overlapping windows keep words from being clipped at seams.
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    ...(options.language ? { language: options.language } : {}),
  })) as WhisperResult | WhisperResult[]

  const flat = Array.isArray(result) ? result[0]! : result
  return toTranscript(flat, model, duration, options.language ?? 'en')
}

function toTranscript(
  result: WhisperResult,
  model: string,
  duration: number,
  language: string,
): Transcript {
  const transcript = emptyTranscript(model, duration, language)

  if (!result.chunks || result.chunks.length === 0) {
    if (result.text?.trim()) {
      transcript.segments = [{ start: 0, end: duration, text: result.text.trim(), words: [] }]
    }
    return transcript
  }

  const segments: TranscriptSegment[] = []
  for (const chunk of result.chunks) {
    const text = chunk.text.trim()
    if (!text) continue

    const start = chunk.timestamp[0] ?? 0
    // Whisper leaves the final chunk's end open; clamp it to the recording.
    const end = chunk.timestamp[1] ?? Math.max(start, duration)
    if (end <= start) continue

    segments.push({
      start,
      end,
      text,
      // Chunks are phrase-level; each is stored as a single word span.
      words: [{ text, start, end }],
    })
  }

  transcript.segments = segments
  return transcript
}

export async function transcribeFile(
  file: File,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  options.onProgress?.({ stage: 'decoding', progress: 0, message: 'Reading the audio…' })

  const { samples, duration } = await extractAudio(file, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (progress) =>
      options.onProgress?.({ stage: 'decoding', progress, message: 'Reading the audio…' }),
  })

  return transcribeAudio(samples, duration, options)
}
