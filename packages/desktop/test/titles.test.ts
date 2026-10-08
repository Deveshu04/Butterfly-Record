import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  captionBaseName,
  cleanTitle,
  defaultRecordingTitle,
  dubBaseName,
  fileExtension,
  fileName,
  fileStem,
  isDefaultTitle,
} from '../src/lib/titles.ts'

describe('defaultRecordingTitle', () => {
  it('formats the local date and time without characters Windows rejects', () => {
    const title = defaultRecordingTitle(new Date(2026, 9, 7, 9, 5))
    assert.equal(title, 'Recording 2026-10-07 09.05')
    assert.doesNotMatch(title, /[\\/:*?"<>|]/)
  })
})

describe('isDefaultTitle', () => {
  it('recognises the recording default, including a uniquified copy', () => {
    assert.equal(isDefaultTitle('Recording 2026-10-07 09.05'), true)
    assert.equal(isDefaultTitle('Recording 2026-10-07 09.05 (2)'), true)
    assert.equal(isDefaultTitle(''), true)
  })

  it('treats a title the user wrote as theirs', () => {
    assert.equal(isDefaultTitle('Quarterly review'), false)
    assert.equal(isDefaultTitle('Recording 2026-10-07 09.05 final'), false)
  })

  it('treats an import still named after its file as default', () => {
    assert.equal(isDefaultTitle('VID_0012', 'VID_0012.mp4'), true)
    assert.equal(isDefaultTitle('Team demo', 'VID_0012.mp4'), false)
  })
})

describe('file name helpers', () => {
  it('splits Windows and POSIX paths', () => {
    assert.equal(fileName('C:\\Videos\\clip.final.MP4'), 'clip.final.MP4')
    assert.equal(fileStem('C:\\Videos\\clip.final.MP4'), 'clip.final')
    assert.equal(fileExtension('C:\\Videos\\clip.final.MP4'), 'mp4')
    assert.equal(fileStem('/tmp/.hidden'), '.hidden')
    assert.equal(fileExtension('dub.hi-IN.wav'), 'wav')
  })
})

describe('cleanTitle', () => {
  it('collapses whitespace and trims', () => {
    assert.equal(cleanTitle('  A \n title\t here '), 'A title here')
    assert.equal(cleanTitle('x'.repeat(300)).length, 200)
  })

  it('never ends in half of a surrogate pair', () => {
    assert.equal(cleanTitle(`${'a'.repeat(199)}\u{1F600} tail`), 'a'.repeat(199))
    assert.equal(cleanTitle(`${'a'.repeat(198)}\u{1F600}`), `${'a'.repeat(198)}\u{1F600}`)
  })
})

describe('output names', () => {
  it('names dubbed copies after the title and language', () => {
    assert.equal(dubBaseName('Demo: part 1', 'Hindi'), 'Demo- part 1 - Hindi')
  })

  it('names caption exports with the language code', () => {
    assert.equal(captionBaseName('Demo', 'ta-IN'), 'Demo.ta-IN')
  })
})
