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
