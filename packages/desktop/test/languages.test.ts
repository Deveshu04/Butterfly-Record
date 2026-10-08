import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LANGUAGES,
  TTS_SPEAKERS,
  canonicalLanguage,
  findLanguage,
  iso639,
  languageName,
} from '../src/lib/languages.ts'

describe('LANGUAGES', () => {
  it('lists the 23 Sarvam languages once each', () => {
    assert.equal(LANGUAGES.length, 23)
    assert.equal(new Set(LANGUAGES.map((language) => language.code)).size, 23)
    assert.ok(LANGUAGES.every((language) => /^[a-z]{2,3}-IN$/.test(language.code)))
  })

  it('has the documented capability counts', () => {
    const count = (flag: 'stt' | 'translate' | 'mayura' | 'tts' | 'dub') =>
      LANGUAGES.filter((language) => language[flag]).length
    assert.equal(count('stt'), 23)
    assert.equal(count('translate'), 23)
    assert.equal(count('mayura'), 11)
    assert.equal(count('tts'), 11)
    assert.equal(count('dub'), 12)
  })

  it('dubs Assamese but has no Bulbul voice for it', () => {
    const assamese = findLanguage('as-IN')!
    assert.equal(assamese.dub, true)
    assert.equal(assamese.tts, false)
  })

  it('gives every language a native name', () => {
    assert.ok(LANGUAGES.every((language) => language.native.length > 0))
  })
})

describe('findLanguage', () => {
  it('maps the Dubbing API code for Odia to the canonical one', () => {
    assert.equal(canonicalLanguage('or-IN'), 'od-IN')
    assert.equal(canonicalLanguage('OD-in'), 'od-IN')
  })

  it('accepts bare language tags', () => {
    assert.equal(canonicalLanguage('hi'), 'hi-IN')
    assert.equal(canonicalLanguage('kok'), 'kok-IN')
  })

  it('returns nothing for unknown codes', () => {
    assert.equal(findLanguage('xx-IN'), undefined)
    assert.equal(canonicalLanguage(null), null)
  })
})

describe('languageName', () => {
  it('names auto-detection and known codes', () => {
    assert.equal(languageName('unknown'), 'Auto-detect')
    assert.equal(languageName('ta-IN'), 'Tamil')
    assert.equal(languageName('or-IN'), 'Odia')
  })

  it('falls back to the code itself', () => {
    assert.equal(languageName('xx-IN'), 'xx-IN')
    assert.equal(languageName(null), 'Unknown language')
  })
})

describe('iso639', () => {
  it('gives three-letter codes for container metadata', () => {
    assert.equal(iso639('hi-IN'), 'hin')
    assert.equal(iso639('od-IN'), 'ori')
    assert.equal(iso639('xx'), undefined)
  })
})

describe('TTS_SPEAKERS', () => {
  it('lists the 37 bulbul:v3 voices', () => {
    assert.equal(TTS_SPEAKERS.length, 37)
    assert.equal(TTS_SPEAKERS.filter((speaker) => speaker.gender === 'male').length, 23)
    assert.equal(TTS_SPEAKERS.filter((speaker) => speaker.gender === 'female').length, 14)
    assert.equal(new Set(TTS_SPEAKERS.map((speaker) => speaker.id)).size, 37)
  })

  it('capitalises display names', () => {
    assert.equal(TTS_SPEAKERS.find((speaker) => speaker.id === 'shubh')?.name, 'Shubh')
  })
})
