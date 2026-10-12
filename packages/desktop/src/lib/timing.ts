import type { TranscriptWord } from '@butterfly-record/core/transcript'

const round = (seconds: number) => Math.round(seconds * 1000) / 1000

/**
 * Saaras timestamps whole phrases, not words, so each word gets the slice of the phrase's
 * time span that matches its share of the characters.
 */
export function interpolateWords(text: string, start: number, end: number): TranscriptWord[] {
  const length = text.length
  if (length === 0) return []
  const span = Math.max(0, end - start)
  const words: TranscriptWord[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const from = match.index
    const to = from + match[0].length
    words.push({
      text: match[0],
      start: round(start + (span * from) / length),
      end: round(start + (span * to) / length),
    })
  }
  return words
}

/** Equal parts no longer than `maxPart` seconds covering [0, duration]. */
export function splitIntoParts(
  duration: number,
  maxPart: number,
): { start: number; end: number }[] {
  const total = Math.max(0, duration)
  const count = Math.max(1, Math.ceil(total / maxPart))
  const size = total / count
  return Array.from({ length: count }, (_, index) => ({
    start: index * size,
    end: index === count - 1 ? total : (index + 1) * size,
  }))
}

/**
 * Diarization ids are opaque and not consistently based: one model counts from zero, another
 * from one, and a third skips numbers. Numbering them in the order people first speak is the
 * only mapping that matches what a viewer sees. Non-numeric ids are already names.
 */
export function speakerNumbering(): (raw: string | null | undefined) => string | null {
  const seen = new Map<string, string>()
  return (raw) => {
    const id = raw?.trim()
    if (!id) return null
    const numbered = /^(?:speaker[\s_-]*)?(\d+)$/i.exec(id)
    if (!numbered) return id
    const key = String(Number(numbered[1]))
    let label = seen.get(key)
    if (label === undefined) {
      label = `Speaker ${seen.size + 1}`
      seen.set(key, label)
    }
    return label
  }
}

const SENTENCE_END = /(?<=[.!?।॥。])\s+|\n+/

/** A caption line a viewer can read in one glance. */
export const MAX_CAPTION_CHARS = 84
/** Beyond this a line has been on screen too long to still match the speech. */
export const MAX_CAPTION_SECONDS = 6
/** Splitting below this would cut phrases into fragments, which reads worse than one long line. */
const MIN_CAPTION_CHARS = 32

/**
 * Caption-sized pieces of a timed chunk. Saaras sometimes returns several sentences as one
 * chunk, which would otherwise sit on the video as a paragraph.
 */
export function splitForCaptions(text: string, seconds: number): string[] {
  const parts = Math.max(1, Math.ceil(Math.max(0, seconds) / MAX_CAPTION_SECONDS))
  const even = Math.max(MIN_CAPTION_CHARS, Math.ceil(text.length / parts))
  return splitForTts(text, Math.min(MAX_CAPTION_CHARS, even))
}

/** Splits text into pieces of at most `max` characters, preferring sentence and word breaks. */
export function splitForTts(text: string, max: number): string[] {
  const pieces: string[] = []
  let current = ''

  const push = (piece: string) => {
    const trimmed = piece.trim()
    if (trimmed) pieces.push(trimmed)
  }

  const units = text
    .split(SENTENCE_END)
    .flatMap((sentence) => (sentence.length <= max ? [sentence] : splitLong(sentence, max)))

  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit
    if (candidate.length <= max) {
      current = candidate
    } else {
      push(current)
      current = unit
    }
  }
  push(current)
  return pieces
}

function splitLong(sentence: string, max: number): string[] {
  const out: string[] = []
  let current = ''
  for (const word of sentence.split(/\s+/)) {
    if (word.length > max) {
      if (current) out.push(current)
      current = ''
      for (let index = 0; index < word.length; index += max) {
        out.push(word.slice(index, index + max))
      }
      continue
    }
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= max) {
      current = candidate
    } else {
      out.push(current)
      current = word
    }
  }
  if (current) out.push(current)
  return out
}

/** Speech up to 5 % longer than its slot is left alone; beyond that it is re-voiced faster. */
export const DUB_TOLERANCE = 1.05
export const MAX_DUB_PACE = 1.6
/** A slot is never treated as shorter than this, so a crowded passage is not sped up absurdly. */
export const MIN_DUB_WINDOW = 0.5

export interface DubCue {
  index: number
  /** Where the original phrase starts, in seconds. */
  start: number
  /** Where the next phrase starts (or the media ends): the latest this cue should finish. */
  limit: number
  text: string
}

export function planDub(
  segments: ReadonlyArray<{ start: number; end: number; text: string }>,
  duration: number,
): DubCue[] {
  const spoken = segments
    .map((segment, index) => ({ index, start: segment.start, text: segment.text.trim() }))
    .filter((segment) => segment.text.length > 0 && segment.start < duration)
    .sort((a, b) => a.start - b.start)

  return spoken.map((segment, position) => ({
    ...segment,
    limit: Math.max(segment.start, spoken[position + 1]?.start ?? duration),
  }))
}

/**
 * Where a cue's speech goes, given where the previous clip ended. A clip that would overlap
 * the previous one is pushed back rather than talked over; the drift closes at the next pause.
 */
export function placeCue(cue: DubCue, cursor: number): { at: number; window: number } {
  const at = Math.max(cue.start, cursor)
  return { at, window: Math.max(MIN_DUB_WINDOW, cue.limit - at) }
}

/** The pace for a second attempt, or null when the clip fits its window. */
export function dubPace(clipSeconds: number, windowSeconds: number): number | null {
  if (clipSeconds <= windowSeconds * DUB_TOLERANCE) return null
  return Math.min(MAX_DUB_PACE, Math.ceil((clipSeconds / windowSeconds) * 100) / 100)
}

/** [start, end) frame ranges of at most `chunkFrames`. */
export function chunkRanges(totalFrames: number, chunkFrames: number): [number, number][] {
  const ranges: [number, number][] = []
  for (let start = 0; start < totalFrames; start += chunkFrames) {
    ranges.push([start, Math.min(totalFrames, start + chunkFrames)])
  }
  return ranges
}
