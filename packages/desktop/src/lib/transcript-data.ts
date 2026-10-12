import {
  TRANSCRIPT_SCHEMA,
  toSrt,
  toVtt,
  type Transcript,
  type TranscriptSegment,
} from '@butterfly-record/core/transcript'

import { interpolateWords, speakerNumbering, splitForCaptions } from './timing.ts'

export interface TimedText {
  start: number
  end: number
  text: string
  speaker?: string | null
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000

/** Shares a chunk's time between its caption lines by how much of the text each one carries. */
function toCaptionLines(cue: TimedText): TimedText[] {
  const seconds = Math.max(0, cue.end - cue.start)
  const lines = splitForCaptions(cue.text, seconds)
  if (lines.length <= 1) return [cue]

  const total = lines.reduce((sum, line) => sum + line.length, 0)
  if (total === 0) return [cue]

  let used = 0
  return lines.map((text, index) => {
    const from = used
    used += text.length
    return {
      start: index === 0 ? cue.start : round(cue.start + (seconds * from) / total),
      end: index === lines.length - 1 ? cue.end : round(cue.start + (seconds * used) / total),
      text,
      speaker: cue.speaker ?? null,
    }
  })
}

export function buildTranscript(
  cues: ReadonlyArray<TimedText>,
  meta: { language: string; model: string; duration: number },
): Transcript {
  const label = speakerNumbering()
  const segments: TranscriptSegment[] = cues
    .map((cue) => ({ ...cue, text: cue.text.replace(/\s+/g, ' ').trim() }))
    .filter((cue) => cue.text.length > 0 && cue.end >= cue.start)
    .sort((a, b) => a.start - b.start)
    .flatMap(toCaptionLines)
    .map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text,
      words: interpolateWords(cue.text, cue.start, cue.end),
      speaker: label(cue.speaker),
    }))

  return {
    schema: TRANSCRIPT_SCHEMA,
    language: meta.language,
    model: meta.model,
    createdAt: new Date().toISOString(),
    duration: meta.duration,
    segments,
  }
}

/** Same timing and speakers, new text; `texts` is index-aligned with the segments. */
export function translateTranscript(
  source: Transcript,
  texts: readonly string[],
  meta: { language: string; model: string },
): Transcript {
  if (texts.length !== source.segments.length) {
    throw new Error('The translation came back with a different number of lines.')
  }
  return {
    ...source,
    language: meta.language,
    model: meta.model,
    createdAt: new Date().toISOString(),
    segments: source.segments.map((segment, index) => {
      const text = (texts[index] ?? '').replace(/\s+/g, ' ').trim()
      return {
        ...segment,
        text,
        words: interpolateWords(text, segment.start, segment.end),
      }
    }),
  }
}

/** Validates a transcript read from disk; returns null for anything unusable. */
export function parseTranscript(json: string): Transcript | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Partial<Transcript>
  if (!Array.isArray(value.segments)) return null

  const segments: TranscriptSegment[] = []
  for (const item of value.segments as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const segment = item as Partial<TranscriptSegment>
    if (typeof segment.start !== 'number' || typeof segment.end !== 'number') continue
    if (typeof segment.text !== 'string') continue
    segments.push({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      words: Array.isArray(segment.words)
        ? segment.words.filter(
            (word) =>
              typeof word?.text === 'string' &&
              typeof word.start === 'number' &&
              typeof word.end === 'number',
          )
        : interpolateWords(segment.text, segment.start, segment.end),
      speaker: typeof segment.speaker === 'string' ? segment.speaker : null,
    })
  }

  return {
    schema: TRANSCRIPT_SCHEMA,
    language: typeof value.language === 'string' ? value.language : 'unknown',
    model: typeof value.model === 'string' ? value.model : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    duration: typeof value.duration === 'number' ? value.duration : (segments.at(-1)?.end ?? 0),
    segments,
  }
}

/** One line per phrase, prefixed with the speaker whenever the speaker changes. */
function toText(transcript: Transcript): string {
  const lines: string[] = []
  let previous: string | null | undefined
  for (const segment of transcript.segments) {
    const text = segment.text.trim()
    if (!text) continue
    const speaker = segment.speaker ?? null
    lines.push(speaker && speaker !== previous ? `${speaker}: ${text}` : text)
    previous = speaker
  }
  return `${lines.join('\n')}\n`
}

export function captionText(transcript: Transcript, format: 'srt' | 'vtt' | 'txt'): string {
  if (format === 'srt') return toSrt(transcript)
  if (format === 'vtt') return toVtt(transcript)
  return toText(transcript)
}

/** Plain text for summarizing, with speaker turns kept so the model can tell people apart. */
export function transcriptForSummary(transcript: Transcript): string {
  return toText(transcript).trim()
}
