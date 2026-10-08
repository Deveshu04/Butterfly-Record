// Transcript-derived cuts. Pure: returns SOURCE-timeline ranges and never mutates an EDL.

import type { EditSegment, FillerLevel, SilenceOptions } from './edl.ts'
import type { Transcript, TranscriptSegment, TranscriptWord } from './transcript.ts'

export interface AutoCutOptions {
  filler: FillerLevel | null
  silence: SilenceOptions | null
}

/** Matches edl.ts: shorter than one frame at 240fps. */
const EPSILON = 1e-4

/** Cuts closer than this merge into one; a shorter island of audio is a click, not content. */
const MERGE_GAP = 0.05

/** Identical words further apart than this are a sentence boundary, not a stutter. */
const MAX_STUTTER_GAP = 0.6

export const DEFAULT_SILENCE: SilenceOptions = { minGap: 1.2, padding: 0.15 }

/** Unambiguous disfluencies, with the spelling variants transcribers emit for the same sound. */
const LIGHT_FILLERS: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'ummm',
  'uhm',
  'uh',
  'uhh',
  'uhhh',
  'erm',
  'er',
  'ah',
  'ahh',
  'hm',
  'hmm',
  'hmmm',
  'mm',
  'mmm',
  'mhm',
  'mmhmm',
  'mm-hmm',
  'uhhuh',
  'uh-huh',
])

/** Preceded by one of these, "like" is a verb, comparison or quotative, not filler. */
const LIKE_IS_MEANINGFUL: ReadonlySet<string> = new Set([
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'who',
  'people',
  "i'd",
  "you'd",
  "we'd",
  "they'd",
  "he'd",
  "she'd",
  "it's",
  "that's",
  "what's",
  'do',
  'does',
  'did',
  "don't",
  "doesn't",
  "didn't",
  'would',
  "wouldn't",
  'will',
  'could',
  'should',
  'might',
  'must',
  'to',
  'is',
  'was',
  'were',
  'are',
  'be',
  'been',
  'being',
  'look',
  'looks',
  'looked',
  'looking',
  'sound',
  'sounds',
  'sounded',
  'feel',
  'feels',
  'felt',
  'seem',
  'seems',
  'seemed',
  'just',
  'more',
  'much',
  'exactly',
  'something',
  'anything',
  'nothing',
  'everything',
])

/** "what kind of file", "some sort of error" — a real noun phrase follows. */
const DETERMINERS: ReadonlySet<string> = new Set([
  'what',
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'every',
  'each',
  'another',
  'other',
  'which',
  'all',
  'both',
  'different',
])

/** "do you know where", "if you know" — an actual question, not a hedge. */
const KNOW_IS_MEANINGFUL: ReadonlySet<string> = new Set([
  'do',
  'does',
  'did',
  "don't",
  "doesn't",
  "didn't",
  'if',
  'as',
  'unless',
  'until',
  'when',
  'once',
])

/** Doubling these is deliberate emphasis: "no no", "very very close". */
const EMPHATIC_REPEATS: ReadonlySet<string> = new Set([
  'no',
  'yes',
  'yeah',
  'yep',
  'very',
  'really',
  'ha',
])

interface FillerEntry {
  /** Normalised tokens, matched consecutively. */
  words: readonly string[]
  /** A preceding token from this set means the phrase is doing real work. */
  blockedAfter?: ReadonlySet<string>
  /** Only counts as filler when the last token carries a question mark. */
  questionTag?: boolean
}

/** Longest phrase first, so "you know" is tried before a single-token rule can consume "you". */
const AGGRESSIVE_ENTRIES: readonly FillerEntry[] = [
  { words: ['you', 'know'], blockedAfter: KNOW_IS_MEANINGFUL },
  { words: ['i', 'mean'], blockedAfter: new Set(['what', 'that', 'which']) },
  { words: ['sort', 'of'], blockedAfter: DETERMINERS },
  { words: ['kind', 'of'], blockedAfter: DETERMINERS },
  { words: ['like'], blockedAfter: LIKE_IS_MEANINGFUL },
  { words: ['basically'] },
  { words: ['actually'] },
  { words: ['literally'] },
  // Only the tag question ", right?" is filler; the question mark is the only signal.
  { words: ['right'], questionTag: true },
].sort((a, b) => b.words.length - a.words.length)

/** Transcribers attach punctuation ("Um,"); only the ends are trimmed, so "don't" survives. */
function normaliseToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

function endsWithQuestionMark(text: string): boolean {
  return /\?["'”’)\]\s]*$/u.test(text)
}

function usableWord(word: TranscriptWord): boolean {
  return Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start
}

/** Context-free (true for "like" in "I like this"); `fillerRanges` decides what is cut. */
export function isFillerWord(word: string, level: FillerLevel): boolean {
  const token = normaliseToken(word)
  if (token.length === 0) return false
  if (LIGHT_FILLERS.has(token)) return true
  if (level !== 'aggressive') return false

  return AGGRESSIVE_ENTRIES.some(
    (entry) =>
      entry.words.length === 1 &&
      entry.words[0] === token &&
      (entry.questionTag !== true || endsWithQuestionMark(word)),
  )
}

/** Ranges of the SOURCE timeline that filler-word removal would cut. */
export function fillerRanges(transcript: Transcript, level: FillerLevel): EditSegment[] {
  const duration = Math.max(0, transcript.duration)
  if (!(duration > 0)) return []

  const ranges: EditSegment[] = []
  for (const segment of transcript.segments) {
    collectFiller(segment, level, ranges)
  }
  return clampAndMerge(ranges, duration)
}

function collectFiller(segment: TranscriptSegment, level: FillerLevel, into: EditSegment[]): void {
  // Without word timings a filler's position inside the segment is unknown, so it is left alone.
  if (segment.words.length === 0) return

  const words = segment.words
  const tokens = words.map((word) => normaliseToken(word.text))

  let index = 0
  while (index < words.length) {
    const length = matchLength(words, tokens, index, level)
    if (length === 0) {
      index++
      continue
    }
    const range = spanOf(words, index, length)
    if (range) into.push(range)
    // Skip the whole match even when unusable: its inner words are not candidates on their own.
    index += length
  }
}

function matchLength(
  words: readonly TranscriptWord[],
  tokens: readonly string[],
  index: number,
  level: FillerLevel,
): number {
  const token = tokens[index]
  if (token === undefined || token.length === 0) return 0

  if (LIGHT_FILLERS.has(token)) return 1
  if (level !== 'aggressive') return 0

  for (const entry of AGGRESSIVE_ENTRIES) {
    if (matchesEntry(words, tokens, index, entry)) return entry.words.length
  }

  return isStutter(words, tokens, index) ? 1 : 0
}

function matchesEntry(
  words: readonly TranscriptWord[],
  tokens: readonly string[],
  index: number,
  entry: FillerEntry,
): boolean {
  for (let offset = 0; offset < entry.words.length; offset++) {
    if (tokens[index + offset] !== entry.words[offset]) return false
  }

  if (entry.questionTag === true) {
    const last = words[index + entry.words.length - 1]
    if (!last || !endsWithQuestionMark(last.text)) return false
  }

  const previous = tokens[index - 1]
  if (previous !== undefined && entry.blockedAfter?.has(previous) === true) return false

  return true
}

/** An immediate repeat ("the the"). The first copy is cut, since it is usually the clipped one. */
function isStutter(
  words: readonly TranscriptWord[],
  tokens: readonly string[],
  index: number,
): boolean {
  const current = tokens[index]
  if (current === undefined || current.length === 0) return false
  if (current !== tokens[index + 1]) return false
  if (EMPHATIC_REPEATS.has(current)) return false

  const first = words[index]
  const second = words[index + 1]
  if (!first || !second) return false
  return second.start - first.end <= MAX_STUTTER_GAP
}

function spanOf(
  words: readonly TranscriptWord[],
  index: number,
  length: number,
): EditSegment | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY

  for (let offset = 0; offset < length; offset++) {
    const word = words[index + offset]
    // A phrase containing an untimed word is never cut.
    if (!word || !usableWord(word)) return null
    start = Math.min(start, word.start)
    end = Math.max(end, word.end)
  }

  return end - start > EPSILON ? { start, end } : null
}

/** Ranges of the SOURCE timeline that silence removal would cut. */
export function silenceRanges(transcript: Transcript, options: SilenceOptions): EditSegment[] {
  const duration = Math.max(0, transcript.duration)
  if (!(duration > 0)) return []

  // Negative padding would cut into speech; a zero minGap would cut every pause between words.
  const minGap = Math.max(options.minGap, EPSILON)
  const padding = Math.max(options.padding, 0)

  const speech = speechIntervals(transcript, duration)
  // No timings at all would read as one long gap; never cut the whole recording.
  if (speech.length === 0) return []

  const ranges: EditSegment[] = []
  const first = speech[0]!
  const last = speech[speech.length - 1]!

  // Leading silence is cut from zero; padding applies only before the first word.
  if (first.start >= minGap) ranges.push({ start: 0, end: first.start - padding })

  for (let index = 1; index < speech.length; index++) {
    const previous = speech[index - 1]!
    const next = speech[index]!
    if (next.start - previous.end < minGap) continue
    ranges.push({ start: previous.end + padding, end: next.start - padding })
  }

  if (duration - last.end >= minGap) ranges.push({ start: last.end + padding, end: duration })

  // Ranges shrunk to nothing by the padding are dropped by clampAndMerge.
  return clampAndMerge(ranges, duration)
}

/**
 * Speech intervals, sorted and merged. A segment without usable word timings counts
 * as speech throughout, so its contents are never cut as silence.
 */
function speechIntervals(transcript: Transcript, duration: number): EditSegment[] {
  const intervals: EditSegment[] = []

  for (const segment of transcript.segments) {
    const timed = segment.words.filter(usableWord)
    if (timed.length > 0) {
      for (const word of timed) intervals.push({ start: word.start, end: word.end })
      continue
    }
    if (Number.isFinite(segment.start) && segment.end - segment.start > EPSILON) {
      intervals.push({ start: segment.start, end: segment.end })
    }
  }

  const clamped: EditSegment[] = []
  for (const interval of intervals) {
    const start = Math.max(0, Math.min(interval.start, duration))
    const end = Math.max(0, Math.min(interval.end, duration))
    if (end > start) clamped.push({ start, end })
  }

  // mergeRanges sorts, so out-of-order word timings are harmless.
  return mergeRanges(clamped, EPSILON)
}

/** Filler and silence ranges combined: sorted, merged, non-overlapping. */
export function autoCutRanges(transcript: Transcript, options: AutoCutOptions): EditSegment[] {
  const duration = Math.max(0, transcript.duration)
  if (!(duration > 0)) return []

  const ranges: EditSegment[] = []
  if (options.filler !== null) ranges.push(...fillerRanges(transcript, options.filler))
  if (options.silence !== null) ranges.push(...silenceRanges(transcript, options.silence))

  return clampAndMerge(ranges, duration)
}

/** Every exported result passes through here: clamped, sorted, non-overlapping. */
function clampAndMerge(ranges: readonly EditSegment[], duration: number): EditSegment[] {
  const clamped: EditSegment[] = []
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, duration))
    const end = Math.max(0, Math.min(range.end, duration))
    // NaN fails this comparison, which discards non-finite input.
    if (end - start > EPSILON) clamped.push({ start, end })
  }
  return mergeRanges(clamped, MERGE_GAP)
}

function mergeRanges(ranges: readonly EditSegment[], tolerance: number): EditSegment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: EditSegment[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + tolerance) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}
