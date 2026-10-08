import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { estimateCost, estimateRupees, formatRupees } from '../src/lib/cost.ts'

describe('estimateRupees', () => {
  it('prices transcription per hour, more with speaker labels', () => {
    assert.equal(estimateRupees('transcribe', 3600, 1), 30)
    assert.equal(estimateRupees('transcribe', 3600, 1, { diarize: true }), 45)
    assert.equal(estimateRupees('transcribe', 1800, 1), 15)
  })

  it('bills transcription for at least one second', () => {
    assert.ok(Math.abs(estimateRupees('transcribe', 0, 1) - 30 / 3600) < 1e-12)
  })

  it('prices translation per 10K characters and language', () => {
    assert.equal(estimateRupees('translate', 0, 1, { chars: 10_000 }), 20)
    assert.equal(estimateRupees('translate', 0, 3, { chars: 5_000 }), 30)
  })

  it('estimates characters from the duration when they are unknown', () => {
    // Ten minutes at about 1,000 characters a minute.
    assert.equal(estimateRupees('translate', 600, 1), 20)
  })

  it('prices Sarvam Dubbing per minute and target language', () => {
    assert.equal(estimateRupees('dub-sarvam', 60, 1), 40)
    assert.equal(estimateRupees('dub-sarvam', 90, 2), 120)
  })

  it('prices voice dubbing as translation plus speech', () => {
    assert.equal(estimateRupees('dub-tts', 0, 1, { chars: 10_000 }), 50)
    assert.equal(estimateRupees('dub-tts', 0, 2, { chars: 10_000 }), 100)
  })
})

describe('formatRupees', () => {
  it('rounds up and groups thousands the Indian way', () => {
    assert.equal(formatRupees(2.1), 'about ₹3')
    assert.equal(formatRupees(3), 'about ₹3')
    assert.equal(formatRupees(123_456), 'about ₹1,23,456')
  })

  it('says when an amount is below a rupee', () => {
    assert.equal(formatRupees(0.4), 'under ₹1')
    assert.equal(formatRupees(0), 'under ₹1')
  })
})

describe('estimateCost', () => {
  it('formats the estimate', () => {
    assert.equal(estimateCost('dub-sarvam', 120, 1), 'about ₹80')
    assert.equal(estimateCost('transcribe', 600, 1), 'about ₹5')
    assert.equal(estimateCost('transcribe', 60, 1), 'under ₹1')
  })
})
