import { describe, expect, it, vi } from 'vitest'
import { classifyPairingError } from '../src/pairing.js'

describe('pairing error classification', () => {
  it('passes plugin errors through unchanged', () => {
    const original = new Error('boom')
    const safe = classifyPairingError(original)
    expect(safe.code).toBe('pairing-failed')
    expect(safe.message).toContain('boom')
  })

  it('detects abort and denial distinctly', () => {
    const aborted = new DOMException('cancelled', 'AbortError')
    expect(classifyPairingError(aborted).code).toBe('pairing-failed')

    const denied = new Error('The pairing request was denied')
    expect(classifyPairingError(denied).code).toBe('pairing-denied')
  })

  it('refuses device-bound (DBSC) cookie exports up front', () => {
    const dbsc = new Error('session uses __Secure-1PSIDRTS device bound credentials')
    expect(classifyPairingError(dbsc).code).toBe('dbsc-session-refused')
  })

  it('maps expiry and invalid cookie failures to actionable codes', () => {
    expect(classifyPairingError(new Error('the attempt expired after 5 minutes')).code).toBe('pairing-expired')
    expect(classifyPairingError(new Error('SESSION_COOKIE_INVALID from the relay')).code).toBe('pairing-failed')
  })
})

describe('pairing flow', () => {
  it('rejects an unparseable cookie export before touching the network', async () => {
    vi.resetModules()
    vi.doMock('gmessages', () => ({
      parseCookieJar: () => { throw new Error('bad jar') },
      pairFromCookies: vi.fn(async () => { throw new Error('must not run') }),
    }))
    const { pairWithGoogle } = await import('../src/pairing.js')
    await expect(pairWithGoogle({
      cookies: 'not a cookie export',
      callbacks: { onVerification: () => {} },
    })).rejects.toMatchObject({ code: 'invalid-cookies' })
    vi.doUnmock('gmessages')
  })

  it('surfaces the verification code and returns the serialized session', async () => {
    vi.resetModules()
    let shown: { emoji: string | null; numeric: string } | undefined
    vi.doMock('gmessages', () => ({
      parseCookieJar: (input: string) => ({ parsed: input }),
      pairFromCookies: vi.fn(async (options: { onVerification: (prompt: { emoji: string | null; numeric: string }) => void }) => {
        options.onVerification({ emoji: '🦄', numeric: '123', number: 123, codeVersion: 2 })
        return { keys: {}, tachyonToken: 'token' }
      }),
      sessionFromPairing: (result: { tachyonToken: string }) => ({ tachyonToken: result.tachyonToken }),
      serializeSessionFile: (session: unknown) => JSON.stringify(session),
      GOOGLE_ENDPOINTS: { receiveUrl: 'x', registerRefreshUrl: 'y', configUrl: 'z' },
      GOOGLE_WEB_API_KEY: 'key',
    }))
    const { pairWithGoogle } = await import('../src/pairing.js')
    const session = await pairWithGoogle({
      cookies: '# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tFALSE\t0\tSID\tsecret',
      callbacks: {
        onVerification: (prompt) => { shown = { emoji: prompt.emoji, numeric: prompt.numeric } },
      },
    })
    expect(shown).toEqual({ emoji: '🦄', numeric: '123' })
    expect(session).toContain('tachyonToken')
    vi.doUnmock('gmessages')
  })
})
