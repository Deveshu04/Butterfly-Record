import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_SETTINGS, normalizeSettings } from '../src/lib/app-settings.ts'
import { DEFAULT_CAMERA_EFFECTS } from '../src/lib/camera-effects.ts'
import { MAX_CAMERA_SIZE, MIN_CAMERA_SIZE } from '../src/lib/camera-layout.ts'

const defaults = DEFAULT_SETTINGS.recording.camera
const cameraIn = (camera: unknown) => normalizeSettings({ recording: { camera } }).recording.camera

describe('normalizeSettings: camera', () => {
  it('starts off, in a circle, mirrored and placed by its corner', () => {
    assert.deepEqual(cameraIn(undefined), defaults)
    assert.deepEqual(cameraIn(null), defaults)
    assert.deepEqual(cameraIn('nonsense'), defaults)
    assert.equal(defaults.enabled, false)
    assert.equal(defaults.position, null)
  })

  it('keeps a complete block as it is', () => {
    const camera = {
      enabled: true,
      deviceId: 'cam-1',
      shape: 'wide' as const,
      size: 320,
      mirror: false,
      corner: 'top-left' as const,
      position: { x: 40, y: 1200 },
      effects: {
        background: 'image' as const,
        blur: 'strong' as const,
        image: 'background-1791817788575.png',
        color: '#e9e6df',
        touchUp: true,
      },
    }
    assert.deepEqual(cameraIn(camera), camera)
  })

  it('replaces an unknown frame or corner field by field', () => {
    const camera = cameraIn({ enabled: 'yes', shape: 'hexagon', corner: 'middle', mirror: 0 })
    assert.equal(camera.enabled, defaults.enabled)
    assert.equal(camera.shape, defaults.shape)
    assert.equal(camera.corner, defaults.corner)
    assert.equal(camera.mirror, defaults.mirror)
  })

  it('holds the size inside the slider range', () => {
    assert.equal(cameraIn({ size: 10 }).size, MIN_CAMERA_SIZE)
    assert.equal(cameraIn({ size: 4000 }).size, MAX_CAMERA_SIZE)
    assert.equal(cameraIn({ size: 241.6 }).size, 242)
    assert.equal(cameraIn({ size: '320' }).size, defaults.size)
    assert.equal(cameraIn({ size: Number.NaN }).size, defaults.size)
  })

  it('treats a missing or empty device as the default camera', () => {
    assert.equal(cameraIn({ deviceId: '' }).deviceId, null)
    assert.equal(cameraIn({ deviceId: 42 }).deviceId, null)
    assert.equal(cameraIn({ deviceId: 'cam-2' }).deviceId, 'cam-2')
  })

  it('keeps a whole screen position and drops a broken one', () => {
    // A monitor left of the primary one has negative coordinates.
    assert.deepEqual(cameraIn({ position: { x: -1920.4, y: 12.5 } }).position, { x: -1920, y: 13 })
    assert.equal(cameraIn({ position: { x: 10 } }).position, null)
    assert.equal(cameraIn({ position: { x: Number.NaN, y: 0 } }).position, null)
    assert.equal(cameraIn({ position: [10, 20] }).position, null)
  })
})

describe('normalizeSettings: camera effects', () => {
  const effectsIn = (effects: unknown) => cameraIn({ effects }).effects

  it('starts with no background and no touch-up', () => {
    assert.deepEqual(defaults.effects, DEFAULT_CAMERA_EFFECTS)
    assert.equal(defaults.effects.background, 'none')
    assert.equal(defaults.effects.touchUp, false)
  })

  it('gives settings saved before effects existed the defaults', () => {
    const older = { enabled: true, deviceId: 'cam-1', shape: 'circle', size: 240, mirror: true }
    assert.deepEqual(cameraIn(older).effects, DEFAULT_CAMERA_EFFECTS)
    assert.deepEqual(effectsIn(null), DEFAULT_CAMERA_EFFECTS)
    assert.deepEqual(effectsIn([1, 2]), DEFAULT_CAMERA_EFFECTS)
  })

  it('replaces an unknown background or strength field by field', () => {
    const effects = effectsIn({
      background: 'beach',
      blur: 'medium',
      touchUp: 'yes',
      color: '#123456',
    })
    assert.equal(effects.background, 'none')
    assert.equal(effects.blur, 'light')
    assert.equal(effects.touchUp, false)
    assert.equal(effects.color, '#123456')
  })

  it('keeps only pictures the app named itself', () => {
    assert.equal(effectsIn({ image: 'background-42.jpg' }).image, 'background-42.jpg')
    assert.equal(effectsIn({ image: 'background-42.webp' }).image, 'background-42.webp')
    const refused = [
      '..\\background-1.jpg',
      'C:\\photo.jpg',
      'background-42.exe',
      'background-.png',
      '',
      42,
    ]
    for (const image of refused) {
      assert.equal(effectsIn({ image }).image, null, String(image))
    }
  })

  it('reads colors in any case and short form, and drops anything else', () => {
    assert.equal(effectsIn({ color: '#ABCDEF' }).color, '#abcdef')
    assert.equal(effectsIn({ color: '#fa0' }).color, '#ffaa00')
    assert.equal(effectsIn({ color: 'red' }).color, DEFAULT_CAMERA_EFFECTS.color)
    assert.equal(effectsIn({ color: '#12345' }).color, DEFAULT_CAMERA_EFFECTS.color)
  })

  it('keeps a picture background with no picture, which draws nothing until one is chosen', () => {
    const effects = effectsIn({ background: 'image', image: null })
    assert.equal(effects.background, 'image')
    assert.equal(effects.image, null)
  })
})
