import type { Edl } from './edl.ts'
import { sourceToOutput } from './edl.ts'

export const TRANSCRIPT_SCHEMA = 1

export interface TranscriptWord {
  text: string
  /** Seconds into the source recording. */
  start: number
  end: number
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  /** Empty when the model gave no word timings. */
  words: TranscriptWord[]
  /** Diarization label; absent or null when speakers were not separated. */
  speaker?: string | null
}

export interface Transcript {
  schema: typeof TRANSCRIPT_SCHEMA
  /** BCP-47-ish tag as reported by the model, e.g. "en". */
  language: string
  model: string
  createdAt: string
  duration: number
  segments: TranscriptSegment[]
}

export function emptyTranscript(model: string, duration: number, language = 'en'): Transcript {
  return {
    schema: TRANSCRIPT_SCHEMA,
    language,
    model,
    createdAt: new Date().toISOString(),
    duration,
    segments: [],
  }
}

export function transcriptText(transcript: Transcript): string {
  return transcript.segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** `HH:MM:SS.mmm` for WebVTT, `HH:MM:SS,mmm` for SubRip. */
function timestamp(seconds: number, decimalSeparator: '.' | ','): string {
  const clamped = Math.max(0, seconds)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = Math.floor(clamped % 60)
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000)

  // Rounding milliseconds can carry into the next second.
  const carry = millis === 1000
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')

  if (carry) return timestamp(Math.floor(clamped) + 1, decimalSeparator)

  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${decimalSeparator}${pad(millis, 3)}`
}

/** An unescaped "<" in a WebVTT cue truncates it. */
function escapeCue(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Cues must be non-empty and ordered, or players reject the whole file. */
function usableSegments(transcript: Transcript): TranscriptSegment[] {
  return transcript.segments
    .filter((segment) => segment.text.trim().length > 0 && segment.end > segment.start)
    .sort((a, b) => a.start - b.start)
}

export function toVtt(transcript: Transcript): string {
  const cues = usableSegments(transcript).map(
    (segment) =>
      `${timestamp(segment.start, '.')} --> ${timestamp(segment.end, '.')}\n${escapeCue(segment.text.trim())}`,
  )
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

export function toSrt(transcript: Transcript): string {
  const cues = usableSegments(transcript).map(
    (segment, index) =>
      // SubRip is 1-indexed; numbering after filtering leaves no gaps.
      `${index + 1}\n${timestamp(segment.start, ',')} --> ${timestamp(segment.end, ',')}\n${segment.text.trim()}`,
  )
  return `${cues.join('\n\n')}\n`
}

export function toPlainText(transcript: Transcript): string {
  return `${transcriptText(transcript)}\n`
}

export interface SubtitleCue {
  /** Seconds. */
  start: number
  end: number
  text: string
}

const SRT_TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})`
const SRT_TIMING = new RegExp(String.raw`^\s*${SRT_TIME}\s*-->\s*${SRT_TIME}`)
const BYTE_ORDER_MARK = 0xfeff

/** The fraction is read as one: ",5" is half a second, as some writers drop trailing zeros. */
function srtSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  fraction: string,
): number {
  const whole = (Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)
  return (whole * 1000 + Number(fraction.padEnd(3, '0'))) / 1000
}

/**
 * Lenient SubRip reader: tolerates a BOM, CRLF, missing index lines, '.' as the millisecond
 * separator and a missing blank line between cues. Cues with no text are dropped.
 */
export function parseSrt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let current: { start: number; end: number; lines: string[] } | null = null

  const close = () => {
    const body = current?.lines.join('\n').trim()
    if (current && body) cues.push({ start: current.start, end: current.end, text: body })
    current = null
  }

  const content = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
  for (const line of content.split(/\r\n|\r|\n/)) {
    const timing = SRT_TIMING.exec(line)
    if (timing) {
      // No blank line before this cue: its index number landed in the previous cue's text.
      if (current && current.lines.length > 1 && /^\d+$/.test(current.lines.at(-1)!)) {
        current.lines.pop()
      }
      close()
      const [, h1, m1, s1, f1, h2, m2, s2, f2] = timing
      current = {
        start: srtSeconds(h1, m1!, s1!, f1!),
        end: srtSeconds(h2, m2!, s2!, f2!),
        lines: [],
      }
      continue
    }

    const trimmed = line.trim()
    if (trimmed === '') close()
    else current?.lines.push(trimmed)
  }
  close()

  return cues
}

export interface TranscriptMatch {
  /** Seconds into the source. */
  time: number
  text: string
  /** Character offset of the match within `text`. */
  offset: number
  length: number
}

export function searchTranscript(transcript: Transcript, query: string): TranscriptMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []

  const matches: TranscriptMatch[] = []
  for (const segment of transcript.segments) {
    const haystack = segment.text.toLowerCase()
    let from = 0
    for (;;) {
      const index = haystack.indexOf(needle, from)
      if (index === -1) break
      matches.push({
        time: timeOfCharacter(segment, index),
        text: segment.text,
        offset: index,
        length: needle.length,
      })
      from = index + needle.length
    }
  }
  return matches
}

function timeOfCharacter(segment: TranscriptSegment, offset: number): number {
  if (segment.words.length > 0) {
    let cursor = 0
    for (const word of segment.words) {
      const index = segment.text.indexOf(word.text, cursor)
      if (index === -1) continue
      if (offset < index + word.text.length) return word.start
      cursor = index + word.text.length
    }
    return segment.words[segment.words.length - 1]!.start
  }

  const ratio = segment.text.length > 0 ? offset / segment.text.length : 0
  return segment.start + (segment.end - segment.start) * ratio
}

const MAX_TITLE = 70

export function autoTitle(transcript: Transcript): string | null {
  const text = transcriptText(transcript).trim()
  if (text.length === 0) return null

  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text
  let title = sentence.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')

  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE)
    const lastSpace = cut.lastIndexOf(' ')
    title = `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`
  }

  return title.length > 0 ? title : null
}

/** Maps onto the edited timeline; a segment spanning a cut is split, not dropped. */
export function applyEdlToTranscript(transcript: Transcript, edl: Edl): Transcript {
  const segments: TranscriptSegment[] = []

  for (const segment of transcript.segments) {
    const words = segment.words.length > 0 ? segment.words : null

    if (!words) {
      // No word timings: keep the segment only if both ends survive.
      const start = sourceToOutput(edl, segment.start)
      const end = sourceToOutput(edl, segment.end)
      if (start === null || end === null || end <= start) continue
      segments.push({ ...segment, start, end })
      continue
    }

    let current: TranscriptSegment | null = null
    for (const word of words) {
      const start = sourceToOutput(edl, word.start)
      const end = sourceToOutput(edl, word.end)
      if (start === null || end === null) {
        // Word was cut: the next surviving word starts a new cue.
        current = null
        continue
      }

      const moved: TranscriptWord = { text: word.text, start, end }
      if (!current) {
        current = { start, end, text: word.text, words: [moved] }
        if (segment.speaker !== undefined) current.speaker = segment.speaker
        segments.push(current)
      } else {
        current.end = end
        current.text = `${current.text} ${word.text}`.replace(/\s+/g, ' ')
        current.words.push(moved)
      }
    }
  }

  return {
    ...transcript,
    duration: edl.segments.reduce((total, s) => total + (s.end - s.start), 0),
    segments,
  }
}
