import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compositeSupported } from '../src/lib/compositor.ts'
import { coverRect, sameAnchor, samePlacement } from '../src/lib/workers/composite-protocol.ts'

describe('coverRect', () => {
  it('uses the whole camera frame when the ratios match', () => {
    assert.deepEqual(coverRect(1280, 720, 640, 360), { x: 0, y: 0, w: 1280, h: 720 })
  })

  it('crops the sides of a wide camera drawn in a circle', () => {
    const rect = coverRect(1280, 720, 240, 240)
    assert.deepEqual(rect, { x: 280, y: 0, w: 720, h: 720 })
    // Centred, and never more than the frame has.
    assert.equal(rect.x * 2 + rect.w, 1280)
  })

  it('crops the top and bottom of a tall camera drawn in a wide frame', () => {
    const rect = coverRect(720, 1280, 320, 180)
    assert.deepEqual(rect, { x: 0, y: 437.5, w: 720, h: 405 })
    assert.equal(rect.y * 2 + rect.h, 1280)
  })

  it('survives a frame with no size of its own', () => {
    assert.deepEqual(coverRect(0, 0, 240, 240), { x: 0, y: 0, w: 0, h: 0 })
    assert.deepEqual(coverRect(640, 480, 0, 0), { x: 0, y: 0, w: 640, h: 480 })
  })
})

describe('samePlacement', () => {
  const at = { anchor: { x: 0.5, y: 0.5 }, size: 240 }

  it('ignores a drag that changed nothing', () => {
    assert.equal(samePlacement(at, { anchor: { x: 0.5, y: 0.5 }, size: 240 }), true)
  })

  it('notices a move and a resize alike', () => {
    assert.equal(samePlacement(at, { anchor: { x: 0.6, y: 0.5 }, size: 240 }), false)
    // A resize keeps the overlay's centre when it grows symmetrically, so the size must
    // be compared too or the camera would follow a drag but not a resize.
    assert.equal(samePlacement(at, { anchor: { x: 0.5, y: 0.5 }, size: 320 }), false)
    assert.equal(samePlacement(at, { anchor: null, size: 240 }), false)
  })
})

describe('sameAnchor', () => {
  it('compares both fractions', () => {
    assert.equal(sameAnchor({ x: 0.25, y: 0.5 }, { x: 0.25, y: 0.5 }), true)
    assert.equal(sameAnchor({ x: 0.25, y: 0.5 }, { x: 0.25, y: 0.51 }), false)
    assert.equal(sameAnchor({ x: 0.25, y: 0.5 }, { x: 0.26, y: 0.5 }), false)
  })

  it('treats a missing anchor as different from any placement', () => {
    assert.equal(sameAnchor(null, null), true)
    assert.equal(sameAnchor(null, { x: 0, y: 0 }), false)
    assert.equal(sameAnchor({ x: 0, y: 0 }, null), false)
  })
})

describe('compositeSupported', () => {
  it('says no where the frame APIs are missing instead of throwing', () => {
    assert.equal(compositeSupported(), false)
  })
})
