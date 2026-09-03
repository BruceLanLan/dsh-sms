/** Stable failures that are safe to render in the settings UI or SMS. */
export type PluginErrorCode =
  | 'invalid-phone'
  | 'invalid-cookies'
  | 'dbsc-session-refused'
  | 'pairing-failed'
  | 'pairing-expired'
  | 'pairing-denied'
  | 'session-dead'
  | 'session-missing'
  | 'credential-readonly'
  | 'settings-readonly'
  | 'settings-conflict'
  | 'runtime-failed'
  | 'google-unavailable'
  | 'busy'
  | 'request-not-found'
  | 'invalid-command'
  | 'internal-error'

/** Redacted failure sent across the RPC boundary. */
export interface PublicPluginError {
  /** Stable machine-readable code. */
  code: PluginErrorCode
  /** Human-readable message containing no secrets or message content. */
  message: string
  /** Optional public identifiers needed for manual resolution. */
  details?: string[]
}

/** Pairing has not started. */
export interface PairingIdle {
  /** Discriminator for an idle pairing state. */
  phase: 'idle'
}

/** Pairing is waiting for the browser to submit the Google cookie export. */
export interface PairingAwaitingCookies {
  /** Discriminator for the cookie-entry state. */
  phase: 'awaiting-cookies'
}

/** Pairing is showing the verification code that must be confirmed on the phone. */
export interface PairingCode {
  /** Discriminator for the code-display state; the phone prompt is pending approval. */
  phase: 'pairing'
  /** Emoji code, or null when Google ships a table this build has not seen. */
  emoji: string | null
  /** Numeric code, always present. */
  numeric: string
}

/** Pairing completed and the session is stored locally. */
export interface PairingReady {
  /** Discriminator for the paired state. */
  phase: 'paired'
  /** Unix time in milliseconds when pairing completed. */
  pairedAt: number
}

/** Pairing stopped on a safe, actionable failure. */
export interface PairingFailed {
  /** Discriminator for the failed state. */
  phase: 'failed'
  /** Redacted pairing failure. */
  error: PublicPluginError
}

/** Complete public pairing state. */
export type PairingView =
  | PairingIdle
  | PairingAwaitingCookies
  | PairingCode
  | PairingReady
  | PairingFailed

/** The listener is locally stopped. */
export interface RuntimeStopped {
  /** Discriminator for a stopped runtime. */
  phase: 'stopped'
}

/** The listener is starting. */
export interface RuntimeStarting {
  /** Discriminator for a starting runtime. */
  phase: 'starting'
}

/** The listener is actively connected to the Google Messages relay. */
export interface RuntimeListening {
  /** Discriminator for a healthy runtime. */
  phase: 'listening'
  /** Unix time in milliseconds when the listener became healthy. */
  connectedAt: number
}

/** The listener is waiting before an automatic reconnect. */
export interface RuntimeRetrying {
  /** Discriminator for reconnect backoff. */
  phase: 'retrying'
  /** One-based reconnect attempt. */
  attempt: number
  /** Unix time in milliseconds when the next start will be attempted. */
  retryAt: number
}

/** The listener exhausted or encountered a non-recoverable local failure. */
export interface RuntimeFailed {
  /** Discriminator for a failed runtime. */
  phase: 'failed'
  /** Redacted runtime failure. */
  error: PublicPluginError
}

/** Complete public runtime state. */
export type RuntimeView =
  | RuntimeStopped
  | RuntimeStarting
  | RuntimeListening
  | RuntimeRetrying
  | RuntimeFailed

/** Complete settings-page projection. */
export interface SmsPluginState {
  /** Monotonic DSH settings revision used for optimistic writes. */
  revision: number
  /** Whether the DSH settings provider accepts changes. */
  settingsWritable: boolean
  /** Whether a Google Messages session is currently configured. */
  credentialConfigured: boolean
  /** Whether the credential provider can replace or remove the credential. */
  credentialWritable: boolean
  /** Public pairing state. */
  pairing: PairingView
  /** Public listener state. */
  runtime: RuntimeView
  /** Authorized E.164 peer numbers. */
  authorizedNumbers?: string[]
  /** Active DSH root session selected for SMS. */
  activeSessionId?: string
}

/** Optimistic request for saving the authorized numbers. */
export interface SaveNumbersRequest {
  /** Authorized E.164 peer numbers whose DMs become DSH prompts. */
  authorizedNumbers: string[]
  /** Settings revision observed by the browser. */
  expectedRevision: number
}

/** Optimistic request for starting pairing with a Google cookie export. */
export interface BeginPairingRequest {
  /** Google Messages cookie export (Netscape, JSON, or name/value map). */
  cookies: string
  /** Settings revision observed by the browser. */
  expectedRevision: number
}

/** Optimistic request for disconnecting local plugin state. */
export interface DisconnectRequest {
  /** Settings revision observed by the browser. */
  expectedRevision: number
}

/** Successful state-changing operation. */
export interface MutationSuccess {
  /** Success discriminator. */
  ok: true
  /** Fresh public state after the operation was accepted. */
  state: SmsPluginState
}

/** Rejected state-changing operation. */
export interface MutationFailure {
  /** Failure discriminator. */
  ok: false
  /** Redacted actionable error. */
  error: PublicPluginError
  /** Fresh public state after the failed operation. */
  state: SmsPluginState
}

/** Result of a settings-page mutation. */
export type MutationResult = MutationSuccess | MutationFailure
