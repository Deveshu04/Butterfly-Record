// On-device transcription; audio never leaves the machine.

import { ALL_FORMATS, AudioSampleSink, Input, type Source } from 'mediabunny'

import type { WhisperChunk } from './speech-windows.ts'
import { emptyTranscript, type Transcript, type TranscriptSegment } from './transcript.ts'
import { sourceForFile } from './source.ts'

export type { WhisperChunk }

/** Whisper expects 16 kHz mono. */
export const TARGET_SAMPLE_RATE = 16_000

export interface TranscribeProgress {
  stage: 'decoding' | 'loading-model' | 'transcribing'
  /** 0..1 within the stage, or null if unknown. */
  progress: number | null
  message: string
}

export type WhisperDevice = 'webgpu' | 'wasm'
export type WhisperDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'
/** Whisper is two ONNX graphs, and each can run at its own precision. */
export type WhisperDtypes =
  | WhisperDtype
  | { encoder_model: WhisperDtype; decoder_model_merged: WhisperDtype }

/** A model file event from transformers.js; `progress_total` sums every file. */
export interface ModelLoadEvent {
  status: string
  file?: string
  /** 0..100 */
  progress?: number
  loaded?: number
  total?: number
}

export interface WhisperOptions {
  /** Hugging Face model id. */
  model?: string
  device?: WhisperDevice
  dtype?: WhisperDtypes
  /**
   * Required in an MV3 extension: ONNX Runtime otherwise fetches its WASM from a
   * CDN, which the extension CSP blocks. The extension passes `chrome.runtime.getURL('/')`.
   * `{ wasm }` alone keeps the JavaScript half bundled and loads only the binary from there.
   */
  wasmPaths?: string | { wasm: string; mjs?: string }
  /** Cache Storage name for downloaded model files; transformers.js picks one otherwise. */
  cacheName?: string
  onLoad?: (event: ModelLoadEvent) => void
}

export interface TranscribeOptions extends WhisperOptions {
  language?: string
  onProgress?: (progress: TranscribeProgress) => void
  signal?: AbortSignal
}

export interface RecognizeOptions {
  /** Whisper language code or name; Whisper assumes English without one. */
  language?: string
  /** 'translate' writes English whatever language is spoken. */
  task?: 'transcribe' | 'translate'
  /** Splits longer audio into overlapping windows; without it, pass at most 30 s. */
  chunked?: boolean
  /** Above 0, samples instead of always taking the likeliest token. */
  temperature?: number
}

export interface WhisperResult {
  text: string
  chunks?: WhisperChunk[]
}

export interface Whisper {
  readonly model: string
  readonly device: WhisperDevice
  recognize(samples: Float32Array, options?: RecognizeOptions): Promise<WhisperResult>
  /** The likeliest Whisper language code for up to 30 s of speech. */
  detectLanguage(samples: Float32Array): Promise<string>
  dispose(): Promise<void>
}

// Larger quantized Whisper builds are not reliably more accurate than base.
export const DEFAULT_MODEL = 'onnx-community/whisper-base'

/**
 * Streams and downmixes rather than using decodeAudioData, so peak memory is the
 * 16 kHz mono output rather than the full decoded PCM.
 */
export async function extractAudio(
  file: File | Source,
  options: { onProgress?: (progress: number) => void; signal?: AbortSignal } = {},
): Promise<{ samples: Float32Array; duration: number }> {
  const source = file instanceof File ? sourceForFile(file) : file
  const input = new Input({ source, formats: ALL_FORMATS })
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

/** The parts of the transformers.js pipeline used here, which its typings leave loose. */
interface Recognizer {
  (audio: Float32Array, options: Record<string, unknown>): Promise<WhisperResult | WhisperResult[]>
  model: {
    generation_config: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number }
    generate(options: Record<string, unknown>): Promise<unknown>
  }
  processor(audio: Float32Array): Promise<{ input_features: unknown }>
  dispose(): Promise<void>
}

export async function loadWhisper(options: WhisperOptions = {}): Promise<Whisper> {
  const model = options.model ?? DEFAULT_MODEL
  const device = options.device ?? 'webgpu'

  const { LogitsProcessor, LogitsProcessorList, env, pipeline } = await import(
    '@huggingface/transformers'
  )

  if (options.wasmPaths) env.backends.onnx.wasm!.wasmPaths = options.wasmPaths
  if (options.cacheName) env.cacheKey = options.cacheName

  const recognizer = (await pipeline('automatic-speech-recognition', model, {
    // The library falls back to WASM when no WebGPU adapter is available.
    device,
    // transformers.js names the encoder 'model' when it lists the files to fetch and
    // 'encoder_model' when it loads them; without both it checks for a file it never uses.
    dtype:
      typeof options.dtype === 'object'
        ? { model: options.dtype.encoder_model, ...options.dtype }
        : (options.dtype ?? 'q8'),
    ...(options.onLoad ? { progress_callback: options.onLoad } : {}),
  })) as unknown as Recognizer

  return {
    model,
    device,

    async recognize(samples, { language, task, chunked = false, temperature = 0 } = {}) {
      const result = await recognizer(samples, {
        return_timestamps: true,
        // Whisper's window is 30 s; overlapping windows keep words from being clipped at seams.
        // A single window gets one pass: with no token limit set, transformers.js encodes the
        // audio after the last phrase again, doubling the work for a window that ends in a pause.
        ...(chunked ? { chunk_length_s: 30, stride_length_s: 5 } : { max_new_tokens: 440 }),
        ...(language ? { language } : {}),
        ...(task ? { task } : {}),
        ...(temperature > 0 ? { do_sample: true, temperature } : {}),
      })
      return Array.isArray(result) ? result[0]! : result
    },

    // transformers.js does not detect the language, so this asks the decoder for the first
    // token after <|startoftranscript|> and keeps only language tokens in the running.
    async detectLanguage(samples) {
      const config = recognizer.model.generation_config
      const languages = Object.entries(config.lang_to_id ?? {}).map(
        ([token, id]) => [token.slice(2, -2), id] as const,
      )
      const start = config.decoder_start_token_id
      if (languages.length === 0 || start === undefined) {
        throw new Error('This speech model cannot detect the spoken language.')
      }

      let detected = languages[0]![0]
      class LanguageOnly extends LogitsProcessor {
        override _call(_ids: bigint[][], logits: { data: unknown }) {
          const scores = logits.data as Float32Array
          let best = -Infinity
          for (const [code, id] of languages) {
            if (scores[id]! > best) {
              best = scores[id]!
              detected = code
            }
          }
          return logits
        }
      }
      const processors = new LogitsProcessorList()
      processors.push(new LanguageOnly())

      const { input_features } = await recognizer.processor(samples)
      await recognizer.model.generate({
        inputs: input_features,
        decoder_input_ids: [start],
        max_new_tokens: 1,
        logits_processor: processors,
      })
      return detected
    },

    dispose: () => recognizer.dispose(),
  }
}

export async function transcribeAudio(
  samples: Float32Array,
  duration: number,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const message = 'Downloading the speech model (first run only)…'
  options.onProgress?.({ stage: 'loading-model', progress: null, message })

  const whisper = await loadWhisper({
    ...options,
    onLoad: (event) => {
      options.onLoad?.(event)
      if (event.status !== 'progress') return
      options.onProgress?.({
        stage: 'loading-model',
        progress: typeof event.progress === 'number' ? event.progress / 100 : null,
        message,
      })
    },
  })

  options.signal?.throwIfAborted()
  options.onProgress?.({ stage: 'transcribing', progress: 0, message: 'Transcribing…' })

  const result = await whisper.recognize(samples, {
    chunked: true,
    ...(options.language ? { language: options.language } : {}),
  })
  return toTranscript(result, whisper.model, duration, options.language ?? 'en')
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
