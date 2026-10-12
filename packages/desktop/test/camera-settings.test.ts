import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_SETTINGS, normalizeSettings } from '../src/lib/app-settings.ts'
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
