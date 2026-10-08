import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fullEdl, removeRange } from '../src/edl.ts'
import {
  applyEdlToTranscript,
  autoTitle,
  emptyTranscript,
  parseSrt,
  searchTranscript,
  toPlainText,
  toSrt,
  toVtt,
  transcriptText,
  type Transcript,
  type TranscriptSegment,
} from '../src/transcript.ts'

function make(segments: Array<Partial<TranscriptSegment> & { start: number; end: number; text: string }>): Transcript {
  return {
    ...emptyTranscript('whisper-base', 100),
    segments: segments.map((segment) => ({ words: [], ...segment })),
  }
}

describe('toVtt', () => {
  it('writes a valid header and cue timings', () => {
    const vtt = toVtt(make([{ start: 0, end: 2.5, text: 'Alright so this' }]))
    assert.match(vtt, /^WEBVTT\n\n/)
    assert.match(vtt, /00:00:00\.000 --> 00:00:02\.500/)
    assert.match(vtt, /Alright so this/)
  })

  it('renders hours once the recording is long enough', () => {
    const vtt = toVtt(make([{ start: 3725.5, end: 3730, text: 'Late' }]))
    assert.match(vtt, /01:02:05\.500 --> 01:02:10\.000/)
  })

  it('escapes the characters WebVTT treats as markup', () => {
    // Unescaped, "a < b" truncates the cue in every player.
    const vtt = toVtt(make([{ start: 0, end: 1, text: 'if a < b && c > d' }]))
    assert.match(vtt, /if a &lt; b &amp;&amp; c &gt; d/)
    // The timing line contains '>' in '-->', so check only the text line.
    const textLine = vtt.split('\n').find((line) => line.includes('if a'))
    assert.doesNotMatch(textLine ?? '', /[<>]/)
  })

  it('drops empty and zero-length cues, which players reject', () => {
    const vtt = toVtt(
      make([
        { start: 0, end: 1, text: 'kept' },
        { start: 1, end: 2, text: '   ' },
        { start: 3, end: 3, text: 'zero length' },
      ]),
    )
    assert.equal(vtt.match(/-->/g)?.length, 1)
  })

  it('orders cues by start time regardless of input order', () => {
    const vtt = toVtt(
      make([
        { start: 10, end: 11, text: 'second' },
        { start: 1, end: 2, text: 'first' },
      ]),
    )
    assert.ok(vtt.indexOf('first') < vtt.indexOf('second'))
  })
})

describe('toSrt', () => {
  it('numbers cues from 1 and uses a comma separator', () => {
    const srt = toSrt(
      make([
        { start: 0, end: 1.25, text: 'one' },
        { start: 2, end: 3, text: 'two' },
      ]),
    )
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,250\none/)
    assert.match(srt, /2\n00:00:02,000 --> 00:00:03,000\ntwo/)
  })

  it('renumbers after dropping an empty cue, leaving no hole', () => {
    const srt = toSrt(
      make([
        { start: 0, end: 1, text: 'one' },
        { start: 1, end: 2, text: '' },
        { start: 2, end: 3, text: 'three' },
      ]),
    )
    const numbers = [...srt.matchAll(/^(\d+)$/gm)].map((match) => match[1])
    assert.deepEqual(numbers, ['1', '2'])
  })
})

describe('timestamp rounding', () => {
  it('carries into the next second rather than emitting :1000', () => {
    // 1.9999s rounds to 1000ms, which would render "00:00:01.1000".
    const vtt = toVtt(make([{ start: 1.9999, end: 3, text: 'x' }]))
    assert.match(vtt, /00:00:02\.000 -->/)
    assert.doesNotMatch(vtt, /\.\d{4}/)
  })

  it('never emits a negative timestamp', () => {
    assert.match(toVtt(make([{ start: -5, end: 1, text: 'x' }])), /00:00:00\.000/)
  })
})

describe('transcriptText', () => {
  it('joins segments into readable prose', () => {
    const transcript = make([
      { start: 0, end: 1, text: 'Hello there.' },
      { start: 1, end: 2, text: 'This is a test.' },
    ])
    assert.equal(transcriptText(transcript), 'Hello there. This is a test.')
    assert.equal(toPlainText(transcript), 'Hello there. This is a test.\n')
  })
})

describe('searchTranscript', () => {
  const transcript = make([
    {
      start: 0,
      end: 4,
      text: 'the checkout flow is broken',
      words: [
        { text: 'the', start: 0, end: 0.4 },
        { text: 'checkout', start: 0.4, end: 1.2 },
        { text: 'flow', start: 1.2, end: 1.6 },
        { text: 'is', start: 1.6, end: 1.8 },
        { text: 'broken', start: 1.8, end: 2.4 },
      ],
    },
    { start: 10, end: 12, text: 'the checkout again' },
  ])

  it('finds matches across segments, case-insensitively', () => {
    const matches = searchTranscript(transcript, 'CHECKOUT')
    assert.equal(matches.length, 2)
  })

  it('uses word timings to seek precisely', () => {
    const [first] = searchTranscript(transcript, 'broken')
    assert.equal(first?.time, 1.8)
  })

  it('interpolates when the model gave no word timings', () => {
    const [, second] = searchTranscript(transcript, 'checkout')
    assert.ok(second!.time >= 10 && second!.time <= 12)
  })

  it('finds every occurrence within one segment', () => {
    const repeated = make([{ start: 0, end: 5, text: 'yes yes yes' }])
    assert.equal(searchTranscript(repeated, 'yes').length, 3)
  })

  it('returns nothing for an empty query', () => {
    assert.deepEqual(searchTranscript(transcript, '   '), [])
  })
})

describe('autoTitle', () => {
  it('uses the first sentence', () => {
    const transcript = make([
      { start: 0, end: 3, text: 'This is the checkout walkthrough. Then we look at the bug.' },
    ])
    assert.equal(autoTitle(transcript), 'This is the checkout walkthrough')
  })

  it('truncates on a word boundary', () => {
    const long = 'a'.repeat(10) + ' ' + 'word '.repeat(40)
    const title = autoTitle(make([{ start: 0, end: 5, text: long }]))!
    assert.ok(title.length <= 71, `got ${title.length}`)
    assert.ok(title.endsWith('…'))
    assert.doesNotMatch(title, /wor…$/)
  })

  it('is null when nothing was said', () => {
    assert.equal(autoTitle(make([])), null)
    assert.equal(autoTitle(make([{ start: 0, end: 1, text: '   ' }])), null)
  })
})

describe('applyEdlToTranscript', () => {
  const transcript = make([
    {
      start: 0,
      end: 6,
      text: 'one two three four',
      words: [
        { text: 'one', start: 0, end: 1 },
        { text: 'two', start: 2, end: 3 },
        { text: 'three', start: 4, end: 5 },
        { text: 'four', start: 5, end: 6 },
      ],
    },
  ])

  it('drops words that were cut and shifts the rest', () => {
    const edited = applyEdlToTranscript(transcript, removeRange(fullEdl(10), 2, 4))
    const words = edited.segments.flatMap((segment) => segment.words.map((word) => word.text))
    assert.deepEqual(words, ['one', 'three', 'four'])
  })

  it('splits a segment across a cut rather than losing half of it', () => {
    const edited = applyEdlToTranscript(transcript, removeRange(fullEdl(10), 2, 4))
    assert.equal(edited.segments.length, 2)
    assert.equal(edited.segments[0]!.text, 'one')
    assert.equal(edited.segments[1]!.text, 'three four')
  })

  it('rebases timings onto the edited timeline', () => {
    const edited = applyEdlToTranscript(transcript, removeRange(fullEdl(10), 2, 4))
    // "three" was at 4s; with 2s removed before it, it is now at 2s.
    assert.equal(edited.segments[1]!.words[0]!.start, 2)
  })

  it('is a no-op for an unedited recording', () => {
    const edited = applyEdlToTranscript(transcript, fullEdl(10))
    assert.equal(edited.segments.length, 1)
    assert.equal(edited.segments[0]!.text, 'one two three four')
  })

  it('reports the edited duration', () => {
    const edited = applyEdlToTranscript(transcript, removeRange(fullEdl(10), 2, 4))
    assert.equal(edited.duration, 8)
  })
})

describe('speaker labels', () => {
  const plain = make([
    { start: 0, end: 1.5, text: 'Hello there' },
    { start: 2, end: 3, text: 'General a < b' },
  ])
  const labelled = make([
    { start: 0, end: 1.5, text: 'Hello there', speaker: 'SPEAKER_00' },
    { start: 2, end: 3, text: 'General a < b', speaker: null },
  ])

  it('leave SRT and WebVTT output unchanged', () => {
    assert.equal(toSrt(labelled), toSrt(plain))
    assert.equal(toVtt(labelled), toVtt(plain))
  })

  it('survive a cut that splits a segment', () => {
    const transcript = make([
      {
        start: 0,
        end: 6,
        text: 'one two three',
        speaker: 'SPEAKER_01',
        words: [
          { text: 'one', start: 0, end: 1 },
          { text: 'two', start: 2, end: 3 },
          { text: 'three', start: 4, end: 5 },
        ],
      },
    ])
    const edited = applyEdlToTranscript(transcript, removeRange(fullEdl(10), 2, 4))
    assert.deepEqual(
      edited.segments.map((segment) => segment.speaker),
      ['SPEAKER_01', 'SPEAKER_01'],
    )
  })

  it('stay absent when the source had none', () => {
    const edited = applyEdlToTranscript(
      make([{ start: 0, end: 2, text: 'one', words: [{ text: 'one', start: 0, end: 1 }] }]),
      fullEdl(10),
    )
    assert.equal('speaker' in edited.segments[0]!, false)
  })
})

describe('parseSrt', () => {
  it('reads standard SubRip', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,250\nWorld\n',
    )
    assert.deepEqual(cues, [
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4.25, text: 'World' },
    ])
  })

  it('accepts CRLF line endings and a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff)
    const cues = parseSrt(
      `${bom}1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n` +
        '2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n',
    )
    assert.deepEqual(
      cues.map((cue) => cue.text),
      ['Hello', 'World'],
    )
    assert.equal(cues[0]!.start, 1)
  })

  it('keeps every line of a multi-line cue', () => {
    const [cue] = parseSrt('1\n00:00:00,000 --> 00:00:02,000\nfirst line\nsecond line\n\n')
    assert.equal(cue?.text, 'first line\nsecond line')
  })

  it('does not need index lines', () => {
    const cues = parseSrt('00:00:01,000 --> 00:00:02,000\nA\n\n00:00:03,000 --> 00:00:04,000\nB')
    assert.deepEqual(
      cues.map((cue) => [cue.start, cue.text]),
      [
        [1, 'A'],
        [3, 'B'],
      ],
    )
  })

  it('accepts a dot or a comma before the milliseconds, and short fractions', () => {
    const [cue] = parseSrt('1\n00:00:01.5 --> 00:00:02,25\nx\n')
    assert.equal(cue?.start, 1.5)
    assert.equal(cue?.end, 2.25)
  })

  it('reads hours and timestamps without an hour field', () => {
    const [long, short] = parseSrt(
      '1\n01:02:05,500 --> 01:02:10,001\nlate\n\n2\n02:03,000 --> 02:04,000\nshort\n',
    )
    assert.equal(long?.start, 3725.5)
    assert.equal(long?.end, 3730.001)
    assert.equal(short?.start, 123)
  })

  it('separates cues that have no blank line between them', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n',
    )
    assert.deepEqual(
      cues.map((cue) => cue.text),
      ['Hello', 'World'],
    )
  })

  it('ignores positioning after the timings and drops cues with no text', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000 X1:10 X2:20 Y1:30 Y2:40\nplaced\n\n' +
        '2\n00:00:03,000 --> 00:00:04,000\n\n',
    )
    assert.deepEqual(cues, [{ start: 1, end: 2, text: 'placed' }])
  })

  it('returns nothing for text that is not SubRip', () => {
    assert.deepEqual(parseSrt(''), [])
    assert.deepEqual(parseSrt('just some words\nand more'), [])
  })

  it('round-trips what toSrt writes', () => {
    const transcript = make([
      { start: 0, end: 1.25, text: 'one' },
      { start: 2, end: 3.5, text: 'two' },
      { start: 3725.5, end: 3730, text: 'late' },
    ])
    assert.deepEqual(
      parseSrt(toSrt(transcript)),
      transcript.segments.map(({ start, end, text }) => ({ start, end, text })),
    )
  })
})
