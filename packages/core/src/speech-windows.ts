// Long recordings are transcribed one Whisper window at a time. Cutting each window at the
// quietest moment near its 30 s limit keeps words whole, and windows with no sound at all
// are skipped, which is also where Whisper is most likely to invent text.

import type { RecognizeOptions, WhisperResult } from './transcribe.ts'

export interface SpeechWindow {
  /** Sample offsets into the audio, end exclusive. */
  start: number
  end: number
  /** False when nothing in the window rises above the silence threshold. */
  voiced: boolean
}

export interface WindowOptions {
  /** Whisper's input length. */
  maxSeconds?: number
  /** How far back from the limit to look for a pause. */
  searchSeconds?: number
  /** RMS level that counts as sound; the default is -50 dBFS. */
  silence?: number
}

const FRAME_SECONDS = 0.02
/** A pause is judged over 0.2 s, so the gap between two syllables does not count as one. */
const PAUSE_FRAMES = 10
/** Sound shorter than this is a click, not speech. */
const MIN_VOICED_FRAMES = 10

function frameLevels(samples: Float32Array, frame: number): Float32Array {
  const levels = new Float32Array(Math.ceil(samples.length / frame))
  for (let index = 0; index < levels.length; index++) {
    const from = index * frame
    const to = Math.min(samples.length, from + frame)
    let sum = 0
    for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!
    levels[index] = Math.sqrt(sum / Math.max(1, to - from))
  }
  return levels
}

/** Index of the frame that starts the quietest PAUSE_FRAMES-long stretch in [from, to). */
function quietestFrame(levels: Float32Array, from: number, to: number): number {
  let best = to
  let bestLevel = Infinity
  for (let index = from; index < to; index++) {
    let sum = 0
    const end = Math.min(levels.length, index + PAUSE_FRAMES)
    for (let i = index; i < end; i++) sum += levels[i]!
    const level = sum / Math.max(1, end - index)
    // Later wins ties, so windows stay as long as they can be.
    if (level <= bestLevel) {
      bestLevel = level
      best = index
    }
  }
  return best
}

export function planSpeechWindows(
  samples: Float32Array,
  sampleRate: number,
  options: WindowOptions = {},
): SpeechWindow[] {
  const maxSeconds = options.maxSeconds ?? 30
  const searchSeconds = Math.min(options.searchSeconds ?? 8, maxSeconds / 2)
  const silence = options.silence ?? 10 ** (-50 / 20)

  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const levels = frameLevels(samples, frame)
  const maxFrames = Math.max(1, Math.floor((maxSeconds * sampleRate) / frame))
  const searchFrames = Math.floor((searchSeconds * sampleRate) / frame)

  const windows: SpeechWindow[] = []
  let first = 0
  while (first < levels.length) {
    let last = levels.length
    if (levels.length - first > maxFrames) {
      // Cut in the middle of the pause, not at its first frame.
      const pause = quietestFrame(levels, first + maxFrames - searchFrames, first + maxFrames - PAUSE_FRAMES)
      last = Math.max(first + 1, Math.min(first + maxFrames, pause + Math.floor(PAUSE_FRAMES / 2)))
    }

    let loud = 0
    for (let index = first; index < last; index++) if (levels[index]! >= silence) loud++

    windows.push({
      start: first * frame,
      end: Math.min(samples.length, last * frame),
      voiced: loud >= Math.min(MIN_VOICED_FRAMES, last - first),
    })
    first = last
  }
  return windows
}

export interface WhisperChunk {
  text: string
  timestamp: [number, number | null]
}

export interface TimedText {
  start: number
  end: number
  text: string
}

/**
 * Whisper's phrase timestamps, moved onto the recording's timeline. Whisper leaves the last
 * phrase open and sometimes runs past the audio it was given, so times are clamped to `end`.
 */
export function chunksToCues(
  chunks: readonly WhisperChunk[],
  { offset = 0, end }: { offset?: number; end: number },
): TimedText[] {
  const cues: TimedText[] = []
  for (const chunk of chunks) {
    const text = chunk.text.trim()
    if (!text) continue
    const start = Math.min(end, offset + (chunk.timestamp[0] ?? 0))
    const stop = Math.min(end, chunk.timestamp[1] === null ? end : offset + chunk.timestamp[1])
    if (stop <= start) continue
    cues.push({ start, end: stop, text })
  }
  return cues
}

/** zlib's ratio above which OpenAI treats Whisper's output as stuck in a loop. */
export const LOOP_RATIO = 2.4
/** Sampling temperatures for a second and third try when the first one loops. */
const RETRY_TEMPERATURES = [0.2, 0.6]

/** Text Whisper produced while looping repeats itself, so it compresses unusually well. */
export async function compressionRatio(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length === 0) return 0
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return bytes.length / (await new Response(compressed).arrayBuffer()).byteLength
}

export interface WindowRecognizer {
  recognize(samples: Float32Array, options: Omit<RecognizeOptions, 'chunked'>): Promise<WhisperResult>
  detectLanguage(samples: Float32Array): Promise<string>
}

export interface WindowedOptions {
  /** Whisper language code; detected from the first speech when absent. */
  language?: string | null
  task?: 'transcribe' | 'translate'
  onDetecting?: () => void
  /** Share of the audio done, 0..1. */
  onProgress?: (fraction: number) => void
}

async function recognizeWindow(
  whisper: WindowRecognizer,
  audio: Float32Array,
  options: Omit<RecognizeOptions, 'chunked'>,
): Promise<WhisperResult> {
  let best = await whisper.recognize(audio, options)
  let ratio = await compressionRatio(best.text)
  for (const temperature of RETRY_TEMPERATURES) {
    if (ratio <= LOOP_RATIO) break
    const retry = await whisper.recognize(audio, { ...options, temperature })
    const retryRatio = await compressionRatio(retry.text)
    if (retryRatio < ratio) {
      best = retry
      ratio = retryRatio
    }
  }
  return best
}

/**
 * Transcribes a recording of any length one window at a time, so memory stays at one
 * window's worth and progress can be reported between windows.
 */
export async function transcribeWindows(
  whisper: WindowRecognizer,
  samples: Float32Array,
  sampleRate: number,
  options: WindowedOptions = {},
): Promise<{ language: string | null; cues: TimedText[] }> {
  let language = options.language ?? null
  const cues: TimedText[] = []
  for (const window of planSpeechWindows(samples, sampleRate)) {
    if (window.voiced) {
      const audio = samples.subarray(window.start, window.end)
      // Detected once, from the first speech, so every window is written in one language.
      if (!language) {
        options.onDetecting?.()
        language = await whisper.detectLanguage(audio)
      }
      const result = await recognizeWindow(whisper, audio, {
        language,
        ...(options.task ? { task: options.task } : {}),
      })
      cues.push(
        ...chunksToCues(result.chunks ?? [{ text: result.text, timestamp: [0, null] }], {
          offset: window.start / sampleRate,
          end: window.end / sampleRate,
        }),
      )
    }
    options.onProgress?.(window.end / samples.length)
  }
  return { language, cues }
}
