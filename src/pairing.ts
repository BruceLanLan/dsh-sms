import {
  GOOGLE_ENDPOINTS,
  GOOGLE_WEB_API_KEY,
  pairFromCookies,
  parseCookieJar,
  serializeSessionFile,
  sessionFromPairing,
  type Endpoints,
  type VerificationPrompt,
} from 'gmessages'
import { PluginError } from './errors.js'

/** Pairing callbacks surfacing the human-in-the-loop steps to the settings page. */
export interface PairingCallbacks {
  /**
   * Called with the verification code that must be compared on the phone.
   * Return once the code is visible to the user; the library then sends the
   * finish request that makes the phone display the pairing prompt.
   */
  onVerification(prompt: VerificationPrompt): Promise<void> | void
}

/** Options for one Google Messages pairing run. */
export interface PairWithGoogleOptions {
  /** Google Messages cookie export (Netscape, JSON, or name/value map). */
  cookies: string
  /** Callbacks surfacing verification steps. */
  callbacks: PairingCallbacks
  /** Network seam; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Relay seam; defaults to the production Google Messages endpoints. */
  endpoints?: Endpoints
  /** Public web-client API key; defaults to the production constant. */
  apiKey?: string
  /** Aborts the pairing attempt. */
  signal?: AbortSignal
  /** Attempt/request-id source for tests. */
  newId?: () => string
}

/** Pair with the phone and return the serialized session blob for durable storage. */
export async function pairWithGoogle(options: PairWithGoogleOptions): Promise<string> {
  let jar: ReturnType<typeof parseCookieJar>
  try {
    jar = parseCookieJar(options.cookies)
  } catch {
    throw new PluginError(
      'invalid-cookies',
      'The pasted cookie export could not be parsed. Export cookies from messages.google.com and try again.',
    )
  }
  try {
    const result = await pairFromCookies({
      endpoints: options.endpoints ?? GOOGLE_ENDPOINTS,
      apiKey: options.apiKey ?? GOOGLE_WEB_API_KEY,
      cookies: jar,
      fetchImpl: options.fetchImpl ?? fetch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
      onVerification: prompt => options.callbacks.onVerification(prompt),
    })
    return serializeSessionFile(sessionFromPairing(result))
  } catch (error) {
    throw classifyPairingError(error)
  }
}

/** Map raw pairing failures to redacted, actionable plugin errors. */
export function classifyPairingError(error: unknown): PluginError {
  if (error instanceof PluginError) return error
  if (isAbortError(error)) {
    return new PluginError('pairing-failed', 'Pairing was cancelled.')
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/DBSC|device.?bound|__Secure-1PSIDRTS/iu.test(message)) {
    return new PluginError(
      'dbsc-session-refused',
      'The cookie export is from a device-bound (DBSC) Chrome session, which cannot be rotated. '
        + 'Sign in from an incognito window or Firefox/Safari and export again.',
    )
  }
  if (/expired|timeout|timed out|5 minutes/iu.test(message)) {
    return new PluginError('pairing-expired', 'The pairing attempt expired. Start again and approve on the phone in time.')
  }
  if (/denied|rejected|cancel|abort|declined/iu.test(message)) {
    return new PluginError('pairing-denied', 'The pairing request was not approved on the phone.')
  }
  if (/SESSION_COOKIE_INVALID|cookie|unauthorized|401|403|jar/iu.test(message)) {
    return new PluginError(
      'pairing-failed',
      'Google refused the cookie export. It may have expired; sign in to messages.google.com again and re-export.',
    )
  }
  return new PluginError('pairing-failed', `Pairing failed: ${message}`)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
