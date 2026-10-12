import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildTranscript,
  captionText,
  parseTranscript,
  transcriptForSummary,
  translateTranscript,
} from '../src/lib/transcript-data.ts'

const meta = { language: 'hi-IN', model: 'saaras:v4', duration: 10 }

describe('buildTranscript', () => {
  it('sorts phrases, drops empty ones, labels speakers and interpolates words', () => {
    const transcript = buildTranscript(
      [
        { start: 4, end: 6, text: 'second  phrase', speaker: '1' },
        { start: 0, end: 2, text: 'first', speaker: '0' },
        { start: 3, end: 3.5, text: '  ' },
      ],
      meta,
    )
    assert.equal(transcript.language, 'hi-IN')
    assert.deepEqual(
      transcript.segments.map((segment) => [segment.text, segment.speaker]),
      [
        ['first', 'Speaker 1'],
        ['second phrase', 'Speaker 2'],
      ],
    )
    assert.equal(transcript.segments[1]!.words.length, 2)
    assert.equal(transcript.segments[1]!.words[0]!.start, 4)
  })

  it('numbers one-based speaker ids from one', () => {
    const transcript = buildTranscript(
      [
        { start: 0, end: 1, text: 'hello', speaker: '1' },
        { start: 1, end: 2, text: 'hi', speaker: '2' },
        { start: 2, end: 3, text: 'again', speaker: '1' },
      ],
      meta,
    )
    assert.deepEqual(
      transcript.segments.map((segment) => segment.speaker),
      ['Speaker 1', 'Speaker 2', 'Speaker 1'],
    )
  })

  it('breaks a paragraph-long chunk into caption-sized lines', () => {
    const text =
      'The first sentence introduces the demo. The second sentence explains the setup step. ' +
      'The third sentence shows the result. The fourth sentence closes the walkthrough.'
    const transcript = buildTranscript([{ start: 0, end: 20.16, text, speaker: '1' }], {
      ...meta,
      duration: 20.16,
    })
    assert.ok(transcript.segments.length >= 3, 'splits into several lines')
    for (const segment of transcript.segments) {
      assert.ok(segment.text.length <= 84, `"${segment.text}" is caption sized`)
      assert.equal(segment.speaker, 'Speaker 1')
      assert.ok(segment.end > segment.start)
    }
    assert.equal(transcript.segments[0]!.start, 0)
    assert.equal(transcript.segments.at(-1)!.end, 20.16)
    for (let index = 1; index < transcript.segments.length; index++) {
      assert.ok(
        transcript.segments[index]!.start >= transcript.segments[index - 1]!.end - 1e-6,
        'lines do not overlap',
      )
    }
    assert.equal(
      transcript.segments.map((segment) => segment.text).join(' '),
      text,
      'no words are lost',
    )
  })

  it('leaves a short line that merely lasts a long time alone', () => {
    const transcript = buildTranscript([{ start: 0, end: 18, text: 'Thanks for watching.' }], {
      ...meta,
      duration: 18,
    })
    assert.equal(transcript.segments.length, 1)
    assert.equal(transcript.segments[0]!.end, 18)
  })

  it('splits a long line with no sentence ends at word breaks', () => {
    const text = 'word '.repeat(40).trim()
    const transcript = buildTranscript([{ start: 0, end: 30, text }], { ...meta, duration: 30 })
    assert.ok(transcript.segments.length >= 2)
    for (const segment of transcript.segments) {
      assert.ok(segment.text.length <= 84)
      assert.doesNotMatch(segment.text, /^\s|\s$/)
    }
  })
})

describe('translateTranscript', () => {
  const source = buildTranscript(
    [
      { start: 0, end: 2, text: 'hello world', speaker: '0' },
      { start: 2, end: 4, text: 'bye' },
    ],
    { ...meta, language: 'en-IN' },
  )

  it('keeps timing and speakers and replaces the text', () => {
    const translated = translateTranscript(source, ['नमस्ते दुनिया', 'अलविदा'], {
      language: 'hi-IN',
      model: 'sarvam-translate:v1',
    })
    assert.equal(translated.language, 'hi-IN')
    assert.equal(translated.segments[0]!.speaker, 'Speaker 1')
    assert.equal(translated.segments[0]!.text, 'नमस्ते दुनिया')
    assert.equal(translated.segments[1]!.end, 4)
    assert.equal(translated.segments[0]!.words.length, 2)
  })

  it('refuses a translation with a different number of lines', () => {
    assert.throws(() => translateTranscript(source, ['one'], { language: 'hi-IN', model: 'x' }))
  })
})

describe('parseTranscript', () => {
  it('reads a stored transcript back', () => {
    const transcript = buildTranscript([{ start: 0, end: 1, text: 'hi', speaker: '0' }], meta)
    assert.deepEqual(parseTranscript(JSON.stringify(transcript)), transcript)
  })

  it('skips malformed segments and rejects non-transcripts', () => {
    const parsed = parseTranscript(
      JSON.stringify({
        language: 'ta-IN',
        segments: [{ start: 0, end: 1, text: 'ok' }, { start: 'x' }],
      }),
    )
    assert.equal(parsed?.segments.length, 1)
    assert.equal(parsed?.segments[0]!.words.length, 1)
    assert.equal(parseTranscript('not json'), null)
    assert.equal(parseTranscript('{"segments": 3}'), null)
  })
})

describe('captionText', () => {
  const transcript = buildTranscript(
    [
      { start: 0, end: 1.5, text: 'Hello', speaker: '0' },
      { start: 1.5, end: 3, text: 'again', speaker: '0' },
      { start: 3, end: 4, text: 'Hi', speaker: '1' },
    ],
    meta,
  )

  it('writes SRT and VTT cues', () => {
    assert.match(captionText(transcript, 'srt'), /^1\n00:00:00,000 --> 00:00:01,500\nHello/)
    assert.match(
      captionText(transcript, 'vtt'),
      /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.500\nHello/,
    )
  })

  it('writes plain text with a label at each change of speaker', () => {
    assert.equal(captionText(transcript, 'txt'), 'Speaker 1: Hello\nagain\nSpeaker 2: Hi\n')
    assert.equal(transcriptForSummary(transcript), 'Speaker 1: Hello\nagain\nSpeaker 2: Hi')
  })
})
