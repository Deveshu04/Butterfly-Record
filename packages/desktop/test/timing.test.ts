import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_DUB_PACE,
  MIN_DUB_WINDOW,
  chunkRanges,
  dubPace,
  interpolateWords,
  placeCue,
  planDub,
  speakerLabel,
  splitForTts,
  splitIntoParts,
} from '../src/lib/timing.ts'

describe('interpolateWords', () => {
  it('spreads a phrase over its span by character position', () => {
    const words = interpolateWords('ab cd', 10, 15)
    assert.deepEqual(words, [
      { text: 'ab', start: 10, end: 12 },
      { text: 'cd', start: 13, end: 15 },
    ])
  })

  it('ignores extra whitespace and handles Indic text', () => {
    const words = interpolateWords('  नमस्ते  दुनिया ', 0, 2)
    assert.deepEqual(
      words.map((word) => word.text),
      ['नमस्ते', 'दुनिया'],
    )
    assert.ok(words.every((word) => word.start >= 0 && word.end <= 2 && word.end > word.start))
  })

  it('returns nothing for empty text', () => {
    assert.deepEqual(interpolateWords('', 0, 1), [])
  })
})

describe('splitIntoParts', () => {
  it('keeps short media in one part', () => {
    assert.deepEqual(splitIntoParts(120, 7000), [{ start: 0, end: 120 }])
  })

  it('splits long media into equal parts below the limit', () => {
    const parts = splitIntoParts(15_000, 7000)
    assert.equal(parts.length, 3)
    assert.ok(parts.every((part) => part.end - part.start <= 7000))
    assert.equal(parts[0]!.start, 0)
    assert.equal(parts.at(-1)!.end, 15_000)
    for (let index = 1; index < parts.length; index++) {
      assert.equal(parts[index]!.start, parts[index - 1]!.end)
    }
  })

  it('returns one empty part when the duration is unknown', () => {
    assert.deepEqual(splitIntoParts(0, 7000), [{ start: 0, end: 0 }])
  })
})

describe('speakerLabel', () => {
  it('numbers zero-based ids from one', () => {
    assert.equal(speakerLabel('0'), 'Speaker 1')
    assert.equal(speakerLabel('SPEAKER_01'), 'Speaker 2')
  })

  it('keeps other labels and drops empty ones', () => {
    assert.equal(speakerLabel('Host'), 'Host')
    assert.equal(speakerLabel(''), null)
    assert.equal(speakerLabel(null), null)
  })
})

describe('splitForTts', () => {
  it('leaves short text alone', () => {
    assert.deepEqual(splitForTts('Hello there.', 2500), ['Hello there.'])
  })

  it('splits at sentence ends, including the danda', () => {
    const pieces = splitForTts('पहला वाक्य। दूसरा वाक्य। तीसरा।', 14)
    assert.ok(pieces.length > 1)
    assert.ok(pieces.every((piece) => piece.length <= 14))
    assert.equal(pieces.join(' '), 'पहला वाक्य। दूसरा वाक्य। तीसरा।')
  })

  it('splits an over-long sentence at word breaks and an over-long word anywhere', () => {
    const text = `${'word '.repeat(10)}${'x'.repeat(25)}`
    const pieces = splitForTts(text, 12)
    assert.ok(pieces.every((piece) => piece.length <= 12))
    assert.equal(pieces.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
  })
})

describe('dub timing', () => {
  const segments = [
    { start: 4, end: 6, text: 'second' },
    { start: 0, end: 3, text: 'first' },
    { start: 5, end: 5.5, text: '   ' },
    { start: 9, end: 10, text: 'third' },
  ]

  it('plans cues in time order, each bounded by the next', () => {
    const cues = planDub(segments, 12)
    assert.deepEqual(
      cues.map((cue) => [cue.text, cue.start, cue.limit]),
      [
        ['first', 0, 4],
        ['second', 4, 9],
        ['third', 9, 12],
      ],
    )
  })

  it('drops cues that start after the media ends', () => {
    assert.equal(planDub(segments, 8).length, 2)
  })

  it('pushes a cue back to avoid talking over the previous clip', () => {
    const [first, second] = planDub(segments, 12)
    assert.deepEqual(placeCue(first!, 0), { at: 0, window: 4 })
    assert.deepEqual(placeCue(second!, 5), { at: 5, window: 4 })
    assert.deepEqual(placeCue(second!, 8.9), { at: 8.9, window: MIN_DUB_WINDOW })
  })

  it('re-voices only clips more than 5 % too long, capped at the maximum pace', () => {
    assert.equal(dubPace(4.1, 4), null)
    assert.equal(dubPace(5, 4), 1.25)
    assert.equal(dubPace(20, 4), MAX_DUB_PACE)
  })
})

describe('chunkRanges', () => {
  it('covers the whole range in bounded slices', () => {
    assert.deepEqual(chunkRanges(10, 4), [
      [0, 4],
      [4, 8],
      [8, 10],
    ])
    assert.deepEqual(chunkRanges(0, 4), [])
  })
})
