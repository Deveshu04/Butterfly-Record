import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_SILENCE,
  autoCutRanges,
  fillerRanges,
  isFillerWord,
  silenceRanges,
} from '../src/auto-edits.ts'
import type { EditSegment } from '../src/edl.ts'
import { emptyTranscript, type Transcript, type TranscriptSegment } from '../src/transcript.ts'

type WordSpec = [text: string, start: number, end: number]

function spoken(spec: WordSpec[]): TranscriptSegment {
  const words = spec.map(([text, start, end]) => ({ text, start, end }))
  return {
    start: words[0]?.start ?? 0,
    end: words[words.length - 1]?.end ?? 0,
    text: words.map((word) => word.text).join(' '),
    words,
  }
}

function unaligned(start: number, end: number, text: string): TranscriptSegment {
  return { start, end, text, words: [] }
}

function make(duration: number, segments: TranscriptSegment[]): Transcript {
  return { ...emptyTranscript('whisper-base', duration), segments }
}

function one(duration: number, spec: WordSpec[]): Transcript {
  return make(duration, [spoken(spec)])
}

// Cut boundaries are wordEnd + padding, which floating point does not represent exactly.
function closeTo(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ~${expected}, got ${actual}`)
}

function assertRanges(actual: EditSegment[], expected: Array<[number, number]>): void {
  assert.equal(actual.length, expected.length, `range count, got ${JSON.stringify(actual)}`)
  expected.forEach(([start, end], index) => {
    closeTo(actual[index]!.start, start, `range ${index} start`)
    closeTo(actual[index]!.end, end, `range ${index} end`)
  })
}

describe('fillerRanges, light', () => {
  it('cuts an unambiguous disfluency at exactly its word timings', () => {
    const transcript = one(10, [
      ['So', 0, 0.4],
      ['um,', 0.5, 0.9],
      ['the', 1, 1.2],
      ['page', 1.2, 1.6],
    ])
    assert.deepEqual(fillerRanges(transcript, 'light'), [{ start: 0.5, end: 0.9 }])
  })

  it('matches through punctuation and case', () => {
    // Whisper attaches punctuation to the token, so "Um," is more common than "um".
    const transcript = one(10, [
      ['Um,', 0, 0.3],
      ['okay', 1, 1.4],
      ['Uh.', 2, 2.3],
      ['right', 3, 3.4],
      ['HMM', 4, 4.3],
    ])
    assertRanges(fillerRanges(transcript, 'light'), [
      [0, 0.3],
      [2, 2.3],
      [4, 4.3],
    ])
  })

  it('takes the whole light vocabulary', () => {
    const vocabulary = ['um', 'uh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm']
    const spec: WordSpec[] = vocabulary.map((word, index) => [word, index * 2, index * 2 + 0.3])
    assert.equal(fillerRanges(one(40, spec), 'light').length, vocabulary.length)
  })

  it('leaves discourse fillers alone — that is what aggressive is for', () => {
    const transcript = one(10, [
      ['you', 0, 0.2],
      ['know', 0.2, 0.5],
      ['basically', 0.6, 1.2],
      ['like', 1.3, 1.5],
      ['actually', 1.6, 2],
    ])
    assert.deepEqual(fillerRanges(transcript, 'light'), [])
  })

  it('merges a run of disfluencies into one cut', () => {
    const transcript = one(10, [
      ['um', 0, 0.3],
      ['uh', 0.33, 0.6],
      ['so', 0.7, 1],
    ])
    assertRanges(fillerRanges(transcript, 'light'), [[0, 0.6]])
  })

  it('keeps disfluencies separated by real speech as separate cuts', () => {
    const transcript = one(10, [
      ['um', 0, 0.3],
      ['so', 0.35, 0.5],
      ['uh', 0.6, 0.9],
    ])
    assertRanges(fillerRanges(transcript, 'light'), [
      [0, 0.3],
      [0.6, 0.9],
    ])
  })

  it('never cuts a word with no usable timing', () => {
    assert.deepEqual(fillerRanges(one(10, [['um', 1, 1]]), 'light'), [])
    assert.deepEqual(fillerRanges(one(10, [['um', 2, 1]]), 'light'), [])
  })

  it('produces nothing for a segment with no word-level alignment', () => {
    const transcript = make(10, [unaligned(0, 4, 'um so basically it works')])
    assert.deepEqual(fillerRanges(transcript, 'light'), [])
  })

  it('clamps a range that starts before zero or runs past the duration', () => {
    const early = fillerRanges(one(5, [['um', -1, 0.5]]), 'light')
    assertRanges(early, [[0, 0.5]])
    const late = fillerRanges(one(5, [['um', 4.5, 9]]), 'light')
    assertRanges(late, [[4.5, 5]])
  })
})

describe('fillerRanges, aggressive', () => {
  it('cuts a two-word phrase as a single range', () => {
    const transcript = one(10, [
      ['I', 0, 0.2],
      ['think', 0.2, 0.5],
      ['you', 0.6, 0.75],
      ['know', 0.75, 1],
      ['it', 1.1, 1.2],
    ])
    assertRanges(fillerRanges(transcript, 'aggressive'), [[0.6, 1]])
  })

  it('leaves "you know" alone when it is an actual question', () => {
    const transcript = one(10, [
      ['do', 0, 0.2],
      ['you', 0.2, 0.4],
      ['know', 0.4, 0.7],
      ['where', 0.8, 1],
    ])
    assert.deepEqual(fillerRanges(transcript, 'aggressive'), [])
  })

  it('cuts "I mean" as a hedge but not as a verb', () => {
    const hedge = one(10, [
      ['I', 0, 0.2],
      ['mean', 0.2, 0.5],
      ['the', 0.6, 0.7],
      ['thing', 0.7, 1],
    ])
    assertRanges(fillerRanges(hedge, 'aggressive'), [[0, 0.5]])

    const verb = one(10, [
      ['that', 0, 0.2],
      ['I', 0.3, 0.4],
      ['mean', 0.4, 0.7],
    ])
    assert.deepEqual(fillerRanges(verb, 'aggressive'), [])
  })

  it('cuts "kind of" as a hedge but not after a determiner', () => {
    const hedge = one(10, [
      ['it', 0, 0.2],
      ['kind', 0.3, 0.5],
      ['of', 0.5, 0.6],
      ['works', 0.7, 1],
    ])
    assertRanges(fillerRanges(hedge, 'aggressive'), [[0.3, 0.6]])

    const nounPhrase = one(10, [
      ['what', 0, 0.2],
      ['kind', 0.3, 0.5],
      ['of', 0.5, 0.6],
      ['file', 0.7, 1],
    ])
    assert.deepEqual(fillerRanges(nounPhrase, 'aggressive'), [])
  })

  it('cuts discourse "like" but never the verb or the comparison', () => {
    const discourse = one(10, [
      ['and', 0, 0.2],
      ['then', 0.2, 0.4],
      ['like', 0.5, 0.7],
      ['it', 0.8, 0.9],
      ['broke', 0.9, 1.2],
    ])
    assertRanges(fillerRanges(discourse, 'aggressive'), [[0.5, 0.7]])

    const verb = one(10, [
      ['I', 0, 0.2],
      ['like', 0.3, 0.5],
      ['this', 0.5, 0.8],
    ])
    assert.deepEqual(fillerRanges(verb, 'aggressive'), [])

    const comparison = one(10, [
      ['it', 0, 0.2],
      ['looks', 0.2, 0.5],
      ['like', 0.5, 0.7],
      ['a', 0.8, 0.9],
      ['bug', 0.9, 1.2],
    ])
    assert.deepEqual(fillerRanges(comparison, 'aggressive'), [])

    // Quotative "I was like, no" — cutting it would leave "I was, no".
    const quotative = one(10, [
      ['I', 0, 0.2],
      ['was', 0.2, 0.4],
      ['like', 0.4, 0.6],
      ['no', 0.8, 1],
    ])
    assert.deepEqual(fillerRanges(quotative, 'aggressive'), [])
  })

  it('takes a segment-initial "like", which has no preceding word to excuse it', () => {
    const transcript = one(10, [
      ['Like,', 0, 0.3],
      ['the', 0.4, 0.5],
      ['whole', 0.5, 0.8],
    ])
    assertRanges(fillerRanges(transcript, 'aggressive'), [[0, 0.3]])
  })

  it('cuts the tag question "right?" but not the direction "right"', () => {
    const tag = one(10, [
      ['okay', 0, 0.3],
      ['right?', 0.4, 0.7],
    ])
    assertRanges(fillerRanges(tag, 'aggressive'), [[0.4, 0.7]])

    const direction = one(10, [
      ['turn', 0, 0.3],
      ['right', 0.4, 0.7],
    ])
    assert.deepEqual(fillerRanges(direction, 'aggressive'), [])
  })

  it('cuts the first of an immediate repeat and keeps the second', () => {
    const transcript = one(10, [
      ['the', 0, 0.2],
      ['the', 0.25, 0.45],
      ['page', 0.5, 0.9],
    ])
    assertRanges(fillerRanges(transcript, 'aggressive'), [[0, 0.2]])
  })

  it('collapses a triple repeat down to the last one', () => {
    const transcript = one(10, [
      ['I', 0, 0.15],
      ['I', 0.2, 0.35],
      ['I', 0.4, 0.55],
      ['think', 0.6, 0.9],
    ])
    // Both earlier copies are cut, merged into one range.
    assertRanges(fillerRanges(transcript, 'aggressive'), [[0, 0.35]])
  })

  it('keeps an emphatic doubling, which the speaker meant', () => {
    const transcript = one(10, [
      ['no', 0, 0.2],
      ['no', 0.25, 0.45],
      ['that', 0.5, 0.7],
    ])
    assert.deepEqual(fillerRanges(transcript, 'aggressive'), [])
  })

  it('keeps a repeat separated by a pause — two sentences, not a stutter', () => {
    const transcript = one(10, [
      ['the', 0, 0.2],
      ['the', 2, 2.2],
    ])
    assert.deepEqual(fillerRanges(transcript, 'aggressive'), [])
  })

  it('refuses a phrase when any of its words has no usable timing', () => {
    const transcript = one(10, [
      ['you', 0, 0],
      ['know', 0.2, 0.5],
    ])
    assert.deepEqual(fillerRanges(transcript, 'aggressive'), [])
  })

  it('is a superset of light', () => {
    const transcript = one(10, [
      ['um', 0, 0.3],
      ['so', 0.4, 0.6],
      ['basically', 0.7, 1.2],
    ])
    assert.equal(fillerRanges(transcript, 'light').length, 1)
    assert.equal(fillerRanges(transcript, 'aggressive').length, 2)
  })

  it('matches phrases across consecutive words only within a segment', () => {
    // A segment boundary marks a pause, so "you" | "know" across one is not a hedge.
    const split = make(10, [spoken([['you', 0, 0.2]]), spoken([['know', 3, 3.3]])])
    assert.deepEqual(fillerRanges(split, 'aggressive'), [])
  })
})

describe('isFillerWord', () => {
  it('recognises disfluencies at both levels, punctuation and all', () => {
    assert.equal(isFillerWord('Um,', 'light'), true)
    assert.equal(isFillerWord('uh.', 'light'), true)
    assert.equal(isFillerWord('HMM', 'light'), true)
    assert.equal(isFillerWord('Um,', 'aggressive'), true)
  })

  it('gates discourse fillers behind aggressive', () => {
    assert.equal(isFillerWord('like', 'light'), false)
    assert.equal(isFillerWord('like', 'aggressive'), true)
    assert.equal(isFillerWord('basically', 'aggressive'), true)
  })

  it('needs the question mark before it will call "right" a filler', () => {
    assert.equal(isFillerWord('right', 'aggressive'), false)
    assert.equal(isFillerWord('right?', 'aggressive'), true)
  })

  it('says nothing about half a phrase, or about nothing at all', () => {
    assert.equal(isFillerWord('you', 'aggressive'), false)
    assert.equal(isFillerWord('', 'light'), false)
    assert.equal(isFillerWord('  ,  ', 'light'), false)
    assert.equal(isFillerWord('summary', 'light'), false)
  })
})

describe('silenceRanges', () => {
  it('cuts a gap between words, leaving the padding at both ends', () => {
    const transcript = one(5, [
      ['a', 0, 1],
      ['b', 3, 4],
    ])
    assertRanges(silenceRanges(transcript, DEFAULT_SILENCE), [[1.15, 2.85]])
  })

  it('ignores a gap shorter than minGap and takes one exactly equal to it', () => {
    // The 1.1s word gap is under minGap; the 2s tail is over it.
    const short = one(5, [
      ['a', 0, 1],
      ['b', 2.1, 3],
    ])
    assertRanges(silenceRanges(short, DEFAULT_SILENCE), [[3.15, 5]])

    const exact = one(6, [
      ['a', 0, 1],
      ['b', 3, 4],
    ])
    assertRanges(silenceRanges(exact, { minGap: 2, padding: 0 }), [
      [1, 3],
      [4, 6],
    ])
  })

  it('measures gaps across segment boundaries too', () => {
    const transcript = make(5, [spoken([['a', 0, 1]]), spoken([['b', 3, 4]])])
    assertRanges(silenceRanges(transcript, DEFAULT_SILENCE), [[1.15, 2.85]])
  })

  it('trims leading dead air from zero', () => {
    const transcript = one(6, [
      ['a', 2, 3],
      ['b', 3, 4],
    ])
    const ranges = silenceRanges(transcript, DEFAULT_SILENCE)
    assert.equal(ranges.length, 2)
    // Padding applies only on the speech side, so the leading cut starts at zero.
    assert.equal(ranges[0]!.start, 0)
    closeTo(ranges[0]!.end, 1.85, 'leading cut end')
    closeTo(ranges[1]!.start, 4.15, 'trailing cut start')
    assert.equal(ranges[1]!.end, 6)
  })

  it('trims trailing dead air out to the recording duration', () => {
    const transcript = one(6, [
      ['a', 0, 1],
      ['b', 1, 2],
    ])
    const ranges = silenceRanges(transcript, DEFAULT_SILENCE)
    assert.equal(ranges.length, 1)
    closeTo(ranges[0]!.start, 2.15, 'trailing cut start')
    assert.equal(ranges[0]!.end, 6)
  })

  it('drops a cut that the padding shrinks to nothing', () => {
    const transcript = one(4, [
      ['a', 0, 1],
      ['b', 2.2, 3],
    ])
    // 2 x 0.7s of padding inverts the 1.2s gap; the tail is padded on one side only.
    assertRanges(silenceRanges(transcript, { minGap: 1, padding: 0.7 }), [[3.7, 4]])
  })

  it('never lets padding widen a cut into speech', () => {
    const transcript = one(6, [
      ['a', 0, 1],
      ['b', 3, 4],
    ])
    const ranges = silenceRanges(transcript, { minGap: 1.2, padding: -1 })
    assert.ok(ranges[0]!.start >= 1, 'cut must not start before the word ended')
    assert.ok(ranges[0]!.end <= 3, 'cut must not run into the next word')
  })

  it('treats a segment with no word timings as speech, not as silence', () => {
    const transcript = make(10, [unaligned(0, 2, 'this bit has no alignment'), spoken([['b', 5, 6]])])
    const ranges = silenceRanges(transcript, DEFAULT_SILENCE)
    assertRanges(ranges, [
      [2.15, 4.85],
      [6.15, 10],
    ])
    assert.ok(
      ranges.every((range) => range.start >= 2),
      'nothing inside the unaligned segment may be cut',
    )
  })

  it('sorts words before measuring, so a jumbled transcript still works', () => {
    const transcript = one(5, [
      ['b', 3, 4],
      ['a', 0, 1],
    ])
    assertRanges(silenceRanges(transcript, DEFAULT_SILENCE), [[1.15, 2.85]])
  })

  it('cuts nothing when the transcript found no speech at all', () => {
    // Treating the whole recording as one gap would delete the entire video.
    assert.deepEqual(silenceRanges(make(30, []), DEFAULT_SILENCE), [])
    assert.deepEqual(silenceRanges(one(30, [['a', 1, 1]]), DEFAULT_SILENCE), [])
  })

  it('ignores words whose timings are out of range or absent', () => {
    const transcript = one(5, [
      ['a', 0, 1],
      ['broken', 2, 2],
      ['b', 3, 4],
    ])
    assertRanges(silenceRanges(transcript, DEFAULT_SILENCE), [[1.15, 2.85]])
  })

  it('exposes a conservative default', () => {
    assert.deepEqual(DEFAULT_SILENCE, { minGap: 1.2, padding: 0.15 })
  })
})

describe('autoCutRanges', () => {
  const transcript = one(10, [
    ['so', 0, 0.5],
    ['um', 0.6, 1],
    ['the', 3, 3.2],
    ['page', 3.2, 3.6],
  ])

  it('returns nothing when both toggles are off', () => {
    assert.deepEqual(autoCutRanges(transcript, { filler: null, silence: null }), [])
  })

  it('matches the individual functions when only one is on', () => {
    assert.deepEqual(
      autoCutRanges(transcript, { filler: 'light', silence: null }),
      fillerRanges(transcript, 'light'),
    )
    assert.deepEqual(
      autoCutRanges(transcript, { filler: null, silence: DEFAULT_SILENCE }),
      silenceRanges(transcript, DEFAULT_SILENCE),
    )
  })

  it('merges a filler cut into the silence cut that abuts it', () => {
    // The "um" ends at 1.0 and the silence cut starts at 1.02; the 20ms between is not content.
    const ranges = autoCutRanges(transcript, {
      filler: 'light',
      silence: { minGap: 1.2, padding: 0.02 },
    })
    assertRanges(ranges, [
      [0.6, 2.98],
      [3.62, 10],
    ])
  })

  it('keeps cuts that are genuinely apart separate', () => {
    const ranges = autoCutRanges(transcript, { filler: 'light', silence: DEFAULT_SILENCE })
    assert.equal(ranges.length, 3)
    assertRanges(ranges, [
      [0.6, 1],
      [1.15, 2.85],
      [3.75, 10],
    ])
  })

  it('returns sorted, non-overlapping ranges from messy input', () => {
    const messy = make(20, [
      spoken([
        ['page', 12, 12.4],
        ['um,', 11, 11.4],
      ]),
      unaligned(6, 7, 'no alignment here'),
      spoken([
        ['Uh.', 1, 1.3],
        ['the', 1.4, 1.6],
        ['the', 1.65, 1.85],
      ]),
    ])
    const ranges = autoCutRanges(messy, { filler: 'aggressive', silence: DEFAULT_SILENCE })
    assert.ok(ranges.length > 0)
    for (const [index, range] of ranges.entries()) {
      assert.ok(range.end > range.start, `range ${index} is empty or inverted`)
      assert.ok(range.start >= 0 && range.end <= 20, `range ${index} escapes the recording`)
      const previous = ranges[index - 1]
      if (previous) assert.ok(range.start > previous.end, `range ${index} overlaps its neighbour`)
    }
  })

  it('cuts nothing at all when the recording has no duration', () => {
    const zero = one(0, [
      ['um', 0, 0.3],
      ['so', 2, 2.4],
    ])
    assert.deepEqual(fillerRanges(zero, 'light'), [])
    assert.deepEqual(silenceRanges(zero, DEFAULT_SILENCE), [])
    assert.deepEqual(autoCutRanges(zero, { filler: 'aggressive', silence: DEFAULT_SILENCE }), [])
  })
})
