import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/chunks.js'
import {
  parseSmsCredential,
  serializeSmsCredential,
  type SmsCredential,
} from '../src/credential.js'
import { publicError } from '../src/errors.js'
import { normalizeE164 } from '../src/phone.js'

const credential: SmsCredential = {
  version: 1,
  session: '{"jar":{},"pairing":{"tachyonToken":"secret-token"},"lastSeen":null}',
}

describe('public primitives', () => {
  it('strictly normalizes E.164 and rejects formatting or oversized values', () => {
    expect(normalizeE164('  +14155552671 ')).toBe('+14155552671')
    expect(normalizeE164('+12')).toBe('+12')
    for (const invalid of ['4155552671', '+01', '+1 415 555 2671', '+1234567890123456']) {
      expect(() => normalizeE164(invalid)).toThrowError(expect.objectContaining({ code: 'invalid-phone' }))
    }
  })

  it('chunks at paragraph boundaries and never splits grapheme clusters', () => {
    expect(chunkText('one paragraph\n\ntwo paragraph', 16)).toEqual(['one paragraph', 'two paragraph'])
    expect(chunkText('header\n    indented', 8)).toEqual(['header', '    inde', 'nted'])
    const family = '👨‍👩‍👧‍👦'
    expect(chunkText(`${family}${family}`, 1)).toEqual([family, family])
    expect(chunkText('', 10)).toEqual([])
  })

  it('round-trips the one opaque credential and redacts unknown failures', () => {
    expect(parseSmsCredential(serializeSmsCredential(credential))).toEqual(credential)
    const safe = publicError(new Error(`failure ${credential.session}`))
    expect(safe).toEqual({
      code: 'internal-error',
      message: 'The SMS plugin encountered an unexpected error. Retry or check host logs.',
    })
  })

  it('rejects malformed credential documents', () => {
    expect(() => parseSmsCredential('not json')).toThrow()
    expect(() => parseSmsCredential(JSON.stringify({ version: 2, session: 'x' }))).toThrow()
    expect(() => parseSmsCredential(JSON.stringify({ version: 1, session: '' }))).toThrow()
  })
})
