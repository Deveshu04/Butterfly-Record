import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LOOP_RATIO,
  chunksToCues,
  compressionRatio,
  planSpeechWindows,
  transcribeWindows,
  type SpeechWindow,
  type WindowRecognizer,
} from '../src/speech-windows.ts'
import type { RecognizeOptions } from '../src/transcribe.ts'

const RATE = 16_000

/** A 220 Hz tone at about -12 dBFS, with silent stretches given in seconds. */
function speech(seconds: number, gaps: Array<[number, number]> = []): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < samples.length; i++) {
    const time = i / RATE
    if (gaps.some(([from, to]) => time >= from && time < to)) continue
    samples[i] = 0.35 * Math.sin(2 * Math.PI * 220 * time)
  }
  return samples
}

function assertTiles(windows: SpeechWindow[], length: number) {
  assert.equal(windows[0]!.start, 0)
  assert.equal(windows.at(-1)!.end, length)
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i]!.start, windows[i - 1]!.end)
  for (const window of windows) assert.ok(window.end - window.start <= 30 * RATE)
}

describe('planSpeechWindows', () => {
  it('keeps audio shorter than a window whole', () => {
    const samples = speech(12)
    assert.deepEqual(planSpeechWindows(samples, RATE), [{ start: 0, end: samples.length, voiced: true }])
  })

  it('cuts long speech inside the pauses near each 30 s limit', () => {
    const samples = speech(70, [
      [25, 25.6],
      [52, 52.6],
    ])
    const windows = planSpeechWindows(samples, RATE)
    assertTiles(windows, samples.length)
    assert.equal(windows.length, 3)
    const first = windows[0]!.end / RATE
    const second = windows[1]!.end / RATE
    assert.ok(first > 25 && first < 25.6, `first cut at ${first}`)
    assert.ok(second > 52 && second < 52.6, `second cut at ${second}`)
    assert.ok(windows.every((window) => window.voiced))
  })

  it('still cuts at the limit when nobody pauses', () => {
    const samples = speech(65)
    const windows = planSpeechWindows(samples, RATE)
    assertTiles(windows, samples.length)
    assert.equal(windows.length, 3)
  })

  it('marks silence and lone clicks as having nothing to transcribe', () => {
    const samples = new Float32Array(100 * RATE)
    samples[40 * RATE] = 0.9
    const windows = planSpeechWindows(samples, RATE)
    assertTiles(windows, samples.length)
    assert.ok(windows.every((window) => !window.voiced))
  })

  it('treats quiet speech above the threshold as speech', () => {
    const samples = speech(5).map((value) => value / 40)
    assert.equal(planSpeechWindows(samples, RATE)[0]!.voiced, true)
  })

  it('returns nothing for no audio', () => {
    assert.deepEqual(planSpeechWindows(new Float32Array(0), RATE), [])
  })
})

describe('chunksToCues', () => {
  it('moves phrases onto the recording timeline', () => {
    const cues = chunksToCues(
      [
        { text: ' Hello there. ', timestamp: [0, 2.5] },
        { text: 'Second line', timestamp: [2.5, 6] },
      ],
      { offset: 60, end: 90 },
    )
    assert.deepEqual(cues, [
      { start: 60, end: 62.5, text: 'Hello there.' },
      { start: 62.5, end: 66, text: 'Second line' },
    ])
  })

  it('closes an open last phrase at the end of its window', () => {
    assert.deepEqual(chunksToCues([{ text: 'trailing', timestamp: [4, null] }], { offset: 30, end: 58 }), [
      { start: 34, end: 58, text: 'trailing' },
    ])
  })

  it('clamps times Whisper placed past the audio and drops what is left empty', () => {
    const cues = chunksToCues(
      [
        { text: 'runs over', timestamp: [10, 29.98] },
        { text: 'after the end', timestamp: [21, 25] },
        { text: '   ', timestamp: [1, 2] },
        { text: 'zero length', timestamp: [3, 3] },
      ],
      { end: 20 },
    )
    assert.deepEqual(cues, [{ start: 10, end: 20, text: 'runs over' }])
  })
})

describe('compressionRatio', () => {
  it('scores a decoding loop far above ordinary speech', async () => {
    const line = 'So in college, I was a government major, which means I had to write a lot of papers.'
    assert.ok((await compressionRatio(line)) < LOOP_RATIO)
    assert.ok((await compressionRatio('నిని'.repeat(200))) > LOOP_RATIO)
    assert.equal(await compressionRatio(''), 0)
  })
})

describe('transcribeWindows', () => {
  function fake(reply: (options: Omit<RecognizeOptions, 'chunked'>) => string) {
    const calls: Array<Omit<RecognizeOptions, 'chunked'>> = []
    let detections = 0
    const whisper: WindowRecognizer = {
      async recognize(samples, options) {
        calls.push(options)
        const text = reply(options)
        return { text, chunks: [{ text, timestamp: [0.5, samples.length / RATE - 0.5] }] }
      },
      async detectLanguage() {
        detections++
        return 'hi'
      },
    }
    return { whisper, calls, detections: () => detections }
  }

  it('detects the language once and places each window on the timeline', async () => {
    const { whisper, calls, detections } = fake(() => 'नमस्ते')
    const progress: number[] = []
    const result = await transcribeWindows(whisper, speech(70, [[25, 25.6]]), RATE, {
      onProgress: (fraction) => progress.push(fraction),
    })
    assert.equal(result.language, 'hi')
    assert.equal(detections(), 1)
    assert.ok(calls.every((options) => options.language === 'hi' && options.temperature === undefined))
    assert.equal(result.cues.length, calls.length)
    assert.equal(result.cues[0]!.start, 0.5)
    assert.ok(result.cues[1]!.start > 25)
    assert.equal(progress.at(-1), 1)
  })

  it('uses the given language and skips silence entirely', async () => {
    const { whisper, calls, detections } = fake(() => 'hello')
    const samples = new Float32Array(60 * RATE)
    samples.set(speech(5), 40 * RATE)
    const result = await transcribeWindows(whisper, samples, RATE, { language: 'en', task: 'translate' })
    assert.equal(detections(), 0)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { language: 'en', task: 'translate' })
    assert.equal(result.language, 'en')
  })

  it('returns no language and no cues for a silent recording', async () => {
    const { whisper, calls } = fake(() => 'Thank you.')
    assert.deepEqual(await transcribeWindows(whisper, new Float32Array(45 * RATE), RATE), {
      language: null,
      cues: [],
    })
    assert.equal(calls.length, 0)
  })

  it('tries again with sampling when a window loops, and keeps the better text', async () => {
    const { whisper, calls } = fake((options) =>
      options.temperature ? 'A sentence that is fine.' : 'పి' + 'ని'.repeat(300),
    )
    const result = await transcribeWindows(whisper, speech(10), RATE, { language: 'te' })
    assert.deepEqual(
      calls.map((options) => options.temperature),
      [undefined, 0.2],
    )
    assert.equal(result.cues[0]!.text, 'A sentence that is fine.')
  })
})
