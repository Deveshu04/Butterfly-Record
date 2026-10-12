import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CAMERA_SHAPES,
  DEFAULT_CAMERA_SIZE,
  MAX_CAMERA_SIZE,
  MIN_CAMERA_SIZE,
  aspectOf,
  clampCameraSize,
  cameraRect,
  compositeRect,
  compositeRectAt,
  cornerRadius,
  isCameraCorner,
  isCameraShape,
  overlaySize,
} from '../src/lib/camera-layout.ts'

describe('aspectOf', () => {
  it('gives each frame its ratio', () => {
    assert.equal(aspectOf('circle'), 1)
    assert.equal(aspectOf('rounded'), 1)
    assert.equal(aspectOf('wide'), 16 / 9)
    assert.equal(aspectOf('tall'), 3 / 4)
  })
})

describe('clampCameraSize', () => {
  it('keeps the width inside the slider range', () => {
    assert.equal(clampCameraSize(240), 240)
    assert.equal(clampCameraSize(10), MIN_CAMERA_SIZE)
    assert.equal(clampCameraSize(5000), MAX_CAMERA_SIZE)
    assert.equal(clampCameraSize(240.6), 241)
  })

  it('falls back to the default for values that are not numbers', () => {
    assert.equal(clampCameraSize(Number.NaN), DEFAULT_CAMERA_SIZE)
    assert.equal(clampCameraSize(Number.POSITIVE_INFINITY), DEFAULT_CAMERA_SIZE)
  })
})

describe('overlaySize', () => {
  it('derives the height from the shape', () => {
    assert.deepEqual(overlaySize('circle', 240), { width: 240, height: 240 })
    assert.deepEqual(overlaySize('rounded', 300), { width: 300, height: 300 })
    assert.deepEqual(overlaySize('wide', 320), { width: 320, height: 180 })
    assert.deepEqual(overlaySize('tall', 240), { width: 240, height: 320 })
  })

  it('clamps the width first', () => {
    assert.deepEqual(overlaySize('wide', 10_000), { width: MAX_CAMERA_SIZE, height: 360 })
  })

  it('never produces a zero dimension', () => {
    for (const shape of CAMERA_SHAPES) {
      const { width, height } = overlaySize(shape, MIN_CAMERA_SIZE)
      assert.ok(width > 0 && height > 0, shape)
    }
  })
})

describe('cornerRadius', () => {
  it('makes a circle from a square', () => {
    assert.equal(cornerRadius('circle', 240, 240), 120)
  })

  it('rounds the other frames by 14 % of the short side', () => {
    const close = (actual: number, expected: number) =>
      assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`)
    close(cornerRadius('rounded', 240, 240), 33.6)
    close(cornerRadius('wide', 320, 180), 25.2)
    close(cornerRadius('tall', 240, 320), 33.6)
  })
})

describe('compositeRect', () => {
  it('places the camera in the chosen corner with a 2.5 % margin', () => {
    const rect = compositeRect(1920, 1080, 'circle', 240, 'bottom-right')
    assert.deepEqual(rect, {
      x: 1920 - 240 - 27,
      y: 1080 - 240 - 27,
      w: 240,
      h: 240,
      radius: 120,
    })
    assert.deepEqual(compositeRect(1920, 1080, 'circle', 240, 'top-left'), {
      x: 27,
      y: 27,
      w: 240,
      h: 240,
      radius: 120,
    })
  })

  it('scales the overlay width by the output height', () => {
    const half = compositeRect(960, 540, 'circle', 240, 'top-left')
    assert.equal(half.w, 120)
    assert.equal(half.h, 120)
    const tall = compositeRect(3840, 2160, 'wide', 240, 'top-right')
    assert.equal(tall.w, 480)
    assert.equal(tall.h, 270)
  })

  it('never takes more than 40 % of the width', () => {
    const rect = compositeRect(640, 1080, 'wide', MAX_CAMERA_SIZE, 'bottom-left')
    assert.equal(rect.w, 256)
    assert.equal(rect.h, 144)
  })

  it('keeps a tall frame inside a short output', () => {
    const rect = compositeRect(1920, 480, 'tall', MAX_CAMERA_SIZE, 'top-left')
    assert.ok(rect.h <= 480 - 2 * rect.y, 'fits between the margins')
    assert.ok(rect.w >= 1 && rect.h >= 1)
  })

  it('stays inside the output for every shape and corner', () => {
    for (const shape of CAMERA_SHAPES) {
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
        const rect = compositeRect(1280, 720, shape, 400, corner)
        assert.ok(rect.x >= 0, `${shape} ${corner} x`)
        assert.ok(rect.y >= 0, `${shape} ${corner} y`)
        assert.ok(rect.x + rect.w <= 1280, `${shape} ${corner} right`)
        assert.ok(rect.y + rect.h <= 720, `${shape} ${corner} bottom`)
      }
    }
  })
})

describe('compositeRectAt', () => {
  it('puts the camera where the overlay sits on screen', () => {
    const middle = compositeRectAt(1920, 1080, 'circle', 240, { x: 0.5, y: 0.5 })
    assert.equal(middle.x + middle.w / 2, 960)
    assert.equal(middle.y + middle.h / 2, 540)

    const left = compositeRectAt(1920, 1080, 'circle', 240, { x: 0.25, y: 0.75 })
    assert.equal(left.x + left.w / 2, 480)
    assert.equal(left.y + left.h / 2, 810)
  })

  it('reaches the very edge, with no corner inset', () => {
    const corner = compositeRectAt(1920, 1080, 'circle', 240, { x: 1, y: 1 })
    assert.equal(corner.x + corner.w, 1920)
    assert.equal(corner.y + corner.h, 1080)
    const origin = compositeRectAt(1920, 1080, 'circle', 240, { x: 0, y: 0 })
    assert.deepEqual([origin.x, origin.y], [0, 0])
  })

  it('never leaves the frame, whatever the anchor says', () => {
    for (const anchor of [
      { x: -3, y: 5 },
      { x: Number.NaN, y: Number.NaN },
      { x: 2, y: -1 },
    ]) {
      const rect = compositeRectAt(1280, 720, 'tall', 500, anchor)
      assert.ok(rect.x >= 0 && rect.y >= 0, JSON.stringify(anchor))
      assert.ok(rect.x + rect.w <= 1280 && rect.y + rect.h <= 720, JSON.stringify(anchor))
    }
  })

  it('keeps the same size and radius as the corner placement', () => {
    const anchored = compositeRectAt(1920, 1080, 'wide', 240, { x: 0.5, y: 0.5 })
    const cornered = compositeRect(1920, 1080, 'wide', 240, 'bottom-right')
    assert.deepEqual(
      [anchored.w, anchored.h, anchored.radius],
      [cornered.w, cornered.h, cornered.radius],
    )
  })
})

describe('cameraRect', () => {
  it('uses the anchor when there is one and the corner otherwise', () => {
    const anchor = { x: 0.1, y: 0.1 }
    assert.deepEqual(
      cameraRect(1920, 1080, 'circle', 240, { anchor, corner: 'bottom-right' }),
      compositeRectAt(1920, 1080, 'circle', 240, anchor),
    )
    assert.deepEqual(
      cameraRect(1920, 1080, 'circle', 240, { anchor: null, corner: 'top-left' }),
      compositeRect(1920, 1080, 'circle', 240, 'top-left'),
    )
  })
})

describe('guards', () => {
  it('recognise the stored values', () => {
    assert.equal(isCameraShape('wide'), true)
    assert.equal(isCameraShape('square'), false)
    assert.equal(isCameraCorner('bottom-right'), true)
    assert.equal(isCameraCorner('middle'), false)
  })
})
