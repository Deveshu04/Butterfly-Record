import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_SETTINGS,
  displayVideoConstraints,
  normalizeSettings,
} from '../src/lib/app-settings.ts'

describe('normalizeSettings', () => {
  it('returns the defaults for an empty or broken file', () => {
    assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
    assert.deepEqual(normalizeSettings('nonsense'), DEFAULT_SETTINGS)
  })

  it('keeps valid values and replaces invalid ones field by field', () => {
    const settings = normalizeSettings({
      theme: 'dark',
      closeToTray: 'yes',
      recording: { quality: '1440p', frameRate: 45, microphoneId: 'abc', countdown: false },
      sarvam: { sttLanguage: 'or-IN', translateModel: 'mayura:v1', ttsSpeaker: 'nobody' },
    })
    assert.equal(settings.theme, 'dark')
    assert.equal(settings.closeToTray, true)
    assert.equal(settings.recording.quality, '1440p')
    assert.equal(settings.recording.frameRate, 30)
    assert.equal(settings.recording.microphoneId, 'abc')
    assert.equal(settings.recording.countdown, false)
    assert.equal(settings.sarvam.sttLanguage, 'od-IN')
    assert.equal(settings.sarvam.translateModel, 'mayura:v1')
    assert.equal(settings.sarvam.ttsSpeaker, DEFAULT_SETTINGS.sarvam.ttsSpeaker)
  })

  it('keeps auto-detect as the transcription language', () => {
    assert.equal(
      normalizeSettings({ sarvam: { sttLanguage: 'unknown' } }).sarvam.sttLanguage,
      'unknown',
    )
    assert.equal(
      normalizeSettings({ sarvam: { sttLanguage: 'klingon' } }).sarvam.sttLanguage,
      'unknown',
    )
  })

  it('does not share nested objects with the defaults', () => {
    const settings = normalizeSettings({})
    settings.recording.countdown = !settings.recording.countdown
    assert.notEqual(settings.recording.countdown, DEFAULT_SETTINGS.recording.countdown)
  })
})

describe('displayVideoConstraints', () => {
  it('caps the height and frame rate and picks the surface', () => {
    const constraints = displayVideoConstraints({
      ...DEFAULT_SETTINGS.recording,
      quality: '720p',
      frameRate: 60,
      scope: 'window',
    })
    assert.equal(constraints.displaySurface, 'window')
    assert.deepEqual(constraints.height, { max: 720 })
    assert.deepEqual(constraints.width, { max: 1280 })
    assert.deepEqual(constraints.frameRate, { ideal: 60, max: 60 })
  })
})
