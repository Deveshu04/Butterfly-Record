import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { errorMessage, isBlocked, isIpcError } from '../src/lib/errors.ts'

const GENERIC_MISSING = 'The file could not be found. It may have been moved or deleted.'

describe('errorMessage', () => {
  it('keeps what Rust said about a missing item', () => {
    assert.equal(
      errorMessage({ code: 'not_found', message: 'This library item no longer exists.' }),
      'This library item no longer exists.',
    )
  })

  it('puts Windows wording behind a sentence that says what failed', () => {
    assert.equal(
      errorMessage({ code: 'not_found', message: 'The system cannot find the path specified. (os error 3)' }),
      `${GENERIC_MISSING} Windows reported: The system cannot find the path specified. (os error 3)`,
    )
    assert.equal(
      errorMessage({ code: 'forbidden', message: 'Access is denied. (os error 5)' }),
      'Butterfly Record is not allowed to use that location. Windows reported: Access is denied. (os error 5)',
    )
  })

  it('falls back to the general sentence only without a detail', () => {
    assert.equal(errorMessage({ code: 'not_found', message: '' }), GENERIC_MISSING)
    assert.equal(errorMessage({ code: 'not_found', message: '   ' }), GENERIC_MISSING)
    assert.equal(
      errorMessage({ code: 'forbidden', message: '' }),
      'Butterfly Record is not allowed to use that location.',
    )
  })

  it('explains a write Windows refused', () => {
    const detail =
      'Windows Security is blocking Butterfly Record from saving to your Videos folder (Controlled folder access). Allow Butterfly Record in Windows Security, or use a folder outside Videos.'
    assert.equal(errorMessage({ code: 'blocked', message: detail }), detail)
    const bare = errorMessage({ code: 'blocked', message: '' })
    assert.match(bare, /Controlled folder access/)
    assert.doesNotMatch(bare, /could not be found/)
  })

  it('keeps friendly sentences for disk and Sarvam errors', () => {
    assert.equal(
      errorMessage({ code: 'disk_full', message: 'The disk is full.' }),
      'The disk is full. Free up some space and try again.',
    )
    assert.equal(
      errorMessage({ code: 'invalid_key', message: 'HTTP 403' }),
      'Sarvam rejected the API key. Check it in Settings.',
    )
  })

  it('describes the remaining IPC codes', () => {
    assert.equal(
      errorMessage({ code: 'io', message: 'Device not ready' }),
      'A file operation failed: Device not ready',
    )
    assert.equal(errorMessage({ code: 'io', message: '' }), 'A file operation failed.')
    assert.equal(
      errorMessage({ code: 'api', message: 'Bad input', requestId: 'r1' }),
      'Sarvam returned an error: Bad input (request r1)',
    )
    assert.equal(errorMessage({ code: 'busy', message: 'Try later.' }), 'Try later.')
    assert.equal(errorMessage({ code: 'busy', message: '' }), 'Something went wrong.')
  })

  it('handles values that are not IPC errors', () => {
    assert.equal(errorMessage(new DOMException('x', 'NotAllowedError')), 'Permission was denied.')
    assert.equal(errorMessage(new Error('Boom')), 'Boom')
    assert.equal(errorMessage('plain'), 'plain')
    assert.equal(errorMessage(undefined), 'Something went wrong.')
  })
})

describe('isBlocked', () => {
  it('recognises only the blocked code', () => {
    assert.equal(isBlocked({ code: 'blocked', message: '' }), true)
    assert.equal(isBlocked({ code: 'not_found', message: '' }), false)
    assert.equal(isBlocked(new Error('blocked')), false)
    assert.equal(isIpcError({ code: 'blocked' }), false)
  })
})
