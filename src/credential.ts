/** Versioned opaque Google Messages session credential document. */
export interface SmsCredential {
  /** Document version. */
  version: 1
  /** Serialized Google Messages session blob (`serializeSessionFile` output). */
  session: string
}

/** Parse a stored credential document, rejecting malformed values. */
export function parseSmsCredential(value: string): SmsCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The stored Google Messages credential is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The stored Google Messages credential is not an object.')
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] !== 1 || typeof record['session'] !== 'string' || record['session'].length === 0) {
    throw new Error('The stored Google Messages credential has an unsupported shape.')
  }
  return { version: 1, session: record['session'] }
}

/** Serialize a credential document for the DSH credential store. */
export function serializeSmsCredential(credential: SmsCredential): string {
  return JSON.stringify(credential)
}
