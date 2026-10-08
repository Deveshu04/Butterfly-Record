import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  WAV_HEADER_BYTES,
  decibelsToGain,
  floatToS16,
  parseWav,
  resampleLinear,
  wavHeader,
} from '../src/lib/wav.ts'

function wav(samples: number[], sampleRate: number, channels: number): Uint8Array {
  const pcm = floatToS16(Float32Array.from(samples))
  const header = wavHeader(samples.length / channels, sampleRate, channels)
  const bytes = new Uint8Array(header.length + pcm.length)
  bytes.set(header)
  bytes.set(pcm, header.length)
  return bytes
}

describe('wavHeader', () => {
  it('writes a canonical 16-bit PCM header', () => {
    const header = wavHeader(48_000, 48_000, 1)
    const view = new DataView(header.buffer)
    assert.equal(header.length, WAV_HEADER_BYTES)
    assert.equal(new TextDecoder().decode(header.subarray(0, 4)), 'RIFF')
    assert.equal(view.getUint32(4, true), 36 + 96_000)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), 48_000)
    assert.equal(view.getUint32(40, true), 96_000)
  })

  it('refuses audio too long for a RIFF file', () => {
    assert.throws(() => wavHeader(3_000_000_000, 48_000, 1))
  })
})

describe('parseWav', () => {
  it('round-trips mono 16-bit audio', () => {
    const audio = parseWav(wav([0, 0.5, -0.5, 1], 24_000, 1))
    assert.equal(audio.sampleRate, 24_000)
    assert.equal(audio.samples.length, 4)
    assert.ok(Math.abs(audio.samples[1]! - 0.5) < 1e-3)
    assert.ok(Math.abs(audio.samples[2]! + 0.5) < 1e-3)
  })

  it('downmixes stereo by averaging the channels', () => {
    const audio = parseWav(wav([0.5, -0.5, 1, 0], 48_000, 2))
    assert.equal(audio.samples.length, 2)
    assert.ok(Math.abs(audio.samples[0]!) < 1e-3)
    assert.ok(Math.abs(audio.samples[1]! - 0.5) < 1e-3)
  })

  it('reads to the end when a streamed WAV leaves the data size at zero', () => {
    const bytes = wav([0.25, 0.25], 16_000, 1)
    new DataView(bytes.buffer).setUint32(40, 0, true)
    assert.equal(parseWav(bytes).samples.length, 2)
  })

  it('skips unknown chunks before the data', () => {
    const plain = wav([0.1, 0.2], 16_000, 1)
    const extra = new Uint8Array([...new TextEncoder().encode('LIST'), 4, 0, 0, 0, 1, 2, 3, 4])
    const bytes = new Uint8Array(plain.length + extra.length)
    bytes.set(plain.subarray(0, 36))
    bytes.set(extra, 36)
    bytes.set(plain.subarray(36), 36 + extra.length)
    assert.equal(parseWav(bytes).samples.length, 2)
  })

  it('rejects other formats', () => {
    assert.throws(() => parseWav(new TextEncoder().encode('ID3 not a wav file')))
  })
})

describe('resampleLinear', () => {
  it('changes the length by the rate ratio', () => {
    assert.equal(resampleLinear(new Float32Array(240), 24_000, 48_000).length, 480)
    assert.equal(resampleLinear(new Float32Array(441), 44_100, 48_000).length, 480)
  })

  it('interpolates between neighbours', () => {
    const out = resampleLinear(Float32Array.from([0, 1]), 1, 2)
    assert.deepEqual(Array.from(out), [0, 0.5, 1, 1])
  })
})

describe('floatToS16', () => {
  it('clamps out-of-range samples', () => {
    const view = new DataView(floatToS16(Float32Array.from([2, -2])).buffer)
    assert.equal(view.getInt16(0, true), 32767)
    assert.equal(view.getInt16(2, true), -32768)
  })
})

describe('decibelsToGain', () => {
  it('converts -18 dB to about one eighth', () => {
    assert.ok(Math.abs(decibelsToGain(-18) - 0.1259) < 1e-4)
  })
})
