import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approachTone,
  blurPlan,
  DEFAULT_CAMERA_EFFECTS,
  effectsActive,
  MAX_BLUR_RADIUS,
  meterLuma,
  mipLevel,
  needsSegmentation,
  NEUTRAL_TONE,
  sameEffects,
  segmentSize,
  shownBackground,
  smoothMask,
  touchUpTone,
  type CameraEffects,
} from '../src/lib/camera-effects.ts'

const effects = (patch: Partial<CameraEffects>): CameraEffects => ({
  ...DEFAULT_CAMERA_EFFECTS,
  ...patch,
})

describe('which effects run', () => {
  it('runs nothing by default', () => {
    assert.equal(effectsActive(DEFAULT_CAMERA_EFFECTS), false)
    assert.equal(needsSegmentation(DEFAULT_CAMERA_EFFECTS), false)
  })

  it('needs the model for every background but none', () => {
    for (const background of ['blur', 'color'] as const) {
      assert.equal(needsSegmentation(effects({ background })), true, background)
    }
    const picture = effects({ background: 'image', image: 'background-1.jpg' })
    assert.equal(needsSegmentation(picture), true)
  })

  it('draws no background for a picture background with no picture chosen', () => {
    const waiting = effects({ background: 'image', image: null })
    assert.equal(shownBackground(waiting), 'none')
    assert.equal(needsSegmentation(waiting), false)
    assert.equal(effectsActive(waiting), false)
  })

  it('runs the touch-up on its own without the model', () => {
    const touchUp = effects({ touchUp: true })
    assert.equal(effectsActive(touchUp), true)
    assert.equal(needsSegmentation(touchUp), false)
  })

  it('compares every field', () => {
    assert.equal(sameEffects(effects({}), effects({})), true)
    assert.equal(sameEffects(effects({}), effects({ color: '#000000' })), false)
    assert.equal(sameEffects(effects({}), effects({ blur: 'strong' })), false)
  })
})

describe('segmentSize', () => {
  it('fits the visible picture into the model input with its shape kept', () => {
    assert.deepEqual(segmentSize(720, 720), { width: 256, height: 256 })
    assert.deepEqual(segmentSize(1280, 720), { width: 256, height: 144 })
    assert.deepEqual(segmentSize(540, 720), { width: 192, height: 256 })
  })

  it('never goes below a usable size', () => {
    assert.deepEqual(segmentSize(4000, 10), { width: 256, height: 16 })
    assert.deepEqual(segmentSize(0, 0), { width: 256, height: 256 })
  })
})

describe('smoothMask', () => {
  it('averages a small change over several frames', () => {
    const running = new Float32Array([0.5])
    smoothMask(running, [0.6])
    assert.ok(running[0]! > 0.5 && running[0]! < 0.6, String(running[0]))
  })

  it('follows a large change at once', () => {
    const running = new Float32Array([0, 1])
    smoothMask(running, [1, 0])
    assert.deepEqual([...running], [1, 0])
  })

  it('settles on a steady mask', () => {
    const running = new Float32Array([0.2])
    for (let frame = 0; frame < 30; frame++) smoothMask(running, [0.3])
    assert.ok(Math.abs(running[0]! - 0.3) < 1e-4, String(running[0]))
  })
})

describe('blurPlan', () => {
  const reach = (plan: ReturnType<typeof blurPlan>) => plan.sigma * plan.scale

  it('blurs the same share of the picture at any size', () => {
    for (const strength of ['light', 'strong'] as const) {
      const small = blurPlan(strength, 240, 240)
      const large = blurPlan(strength, 1280, 1280)
      assert.ok(Math.abs(reach(small) / 240 - reach(large) / 1280) < 1e-9, strength)
    }
  })

  it('blurs more when strong', () => {
    assert.ok(reach(blurPlan('strong', 720, 720)) > 2 * reach(blurPlan('light', 720, 720)))
  })

  it('works on a smaller copy with a bounded number of samples', () => {
    const plan = blurPlan('strong', 1280, 720)
    assert.ok(plan.scale > 1)
    assert.equal(plan.width, Math.ceil(1280 / plan.scale))
    assert.equal(plan.height, Math.ceil(720 / plan.scale))
    assert.ok(plan.radius >= 1 && plan.radius <= MAX_BLUR_RADIUS)
    // Three standard deviations either side: the kernel is not cut off visibly.
    assert.ok(plan.radius >= Math.min(MAX_BLUR_RADIUS, plan.sigma * 3 - 1e-9))
  })

  it('survives a tiny or empty output', () => {
    const plan = blurPlan('light', 0, 0)
    assert.ok(plan.width >= 1 && plan.height >= 1 && plan.scale >= 1)
  })
})

describe('mipLevel', () => {
  it('matches the reduction', () => {
    assert.equal(mipLevel(720, 180), 2)
    assert.equal(mipLevel(720, 720), 0)
  })

  it('never asks for less than the full picture', () => {
    assert.equal(mipLevel(100, 400), 0)
    assert.equal(mipLevel(0, 100), 0)
  })
})

describe('touchUpTone', () => {
  const lifted = (luma: number) => luma ** touchUpTone(luma).gamma

  it('leaves a well-lit picture alone', () => {
    assert.deepEqual(touchUpTone(0.5), NEUTRAL_TONE)
    assert.deepEqual(touchUpTone(0.9), NEUTRAL_TONE)
    assert.deepEqual(touchUpTone(Number.NaN), NEUTRAL_TONE)
  })

  it('lifts a dim picture part of the way, not all of it', () => {
    for (const luma of [0.1, 0.2, 0.3]) {
      const after = lifted(luma)
      assert.ok(after > luma && after < 0.45, `${luma} -> ${after}`)
    }
  })

  it('lifts a darker picture more, within a limit', () => {
    assert.ok(touchUpTone(0.1).gamma < touchUpTone(0.3).gamma)
    assert.ok(touchUpTone(0.01).gamma >= 0.6)
  })

  it('gives back a little contrast and colour as it lifts', () => {
    const tone = touchUpTone(0.15)
    assert.ok(tone.contrast > 1 && tone.contrast < 1.1)
    assert.ok(tone.saturation > 1 && tone.saturation < 1.1)
  })
})

describe('approachTone', () => {
  const target = { gamma: 0.7, contrast: 1.05, saturation: 1.05 }

  it('moves part of the way per frame and gets there in the end', () => {
    const frame = approachTone(NEUTRAL_TONE, target, 33)
    assert.ok(frame.gamma < 1 && frame.gamma > 0.95, String(frame.gamma))
    const later = approachTone(NEUTRAL_TONE, target, 10_000)
    assert.ok(Math.abs(later.gamma - target.gamma) < 1e-4)
  })

  it('stands still without time passing', () => {
    assert.deepEqual(approachTone(NEUTRAL_TONE, target, 0), NEUTRAL_TONE)
  })
})

describe('meterLuma', () => {
  function picture(width: number, height: number, value: (x: number, y: number) => number) {
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4
        pixels.fill(value(x, y), at, at + 3)
        pixels[at + 3] = 255
      }
    }
    return pixels
  }

  it('reads a flat grey as its own brightness', () => {
    assert.ok(Math.abs(meterLuma(picture(16, 16, () => 128), 16, 16) - 128 / 255) < 1e-6)
  })

  it('counts the middle more than the edges', () => {
    const face = picture(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? 200 : 40))
    const plainMean = (64 * 200 + 192 * 40) / 256 / 255
    assert.ok(meterLuma(face, 16, 16) > plainMean)
  })
})
