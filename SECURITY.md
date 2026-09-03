# Security

`dsh-sms` routes SMS/RCS through Google Messages for Web. The transport holds
account-wide Google credentials and can read and send messages from your real
phone number, so this document states what the plugin does with them.

## Data handling

- **The Google session is a credential.** The serialized session document is
  stored only in the DSH credential store under the opaque reference
  `DSH_SMS_GOOGLE_SESSION`. It is never written to plugin settings, never
  returned by any RPC, never logged, and never included in error messages.
- **Cookies are transient.** The cookie export pasted during pairing is used
  for the pairing exchange and discarded; it is not stored after pairing
  succeeds. The session document that pairing produces is what persists.
- **Message content stays local.** Inbound text is routed to DSH as a prompt;
  outbound answers are sent back over the same conversation. Neither message
  text nor raw phone numbers are written to plugin logs.
- **Session rotation is single-writer.** The live connection is the only
  writer of the stored session blob (`onSessionUpdate` → credential store).
  Reconnects re-read the latest blob, so a rotated session is never clobbered.

## Authorization boundary

- Only **1:1 conversations** are considered: rosters must resolve to exactly
  one "me" participant and one peer. Group chats are ignored.
- Only conversations whose **peer number is in the configured authorized
  list** (E.164, normalized with a bounded country-code suffix fallback) are
  accepted. Unknown numbers are dropped without a reply.
- Your own sends, media-only messages, and empty text are ignored.
- Anything any authorized sender can prompt is limited to what the DSH
  workspace the plugin runs in can do with its configured tools. Restrict the
  authorized-number list to people you trust with that capability.

## Fail-closed behavior

- Approvals and questions are only forwarded over SMS while the listener is
  healthy and the turn was claimed by this plugin's exact message id; any
  delivery failure resolves the interaction as cancelled/unavailable rather
  than continuing.
- Pairing aborts on disconnect and on plugin teardown; in-flight pairing never
  completes after the host is gone.
- Errors crossing the RPC boundary are redacted: stable codes plus
  human-readable messages that contain no secrets or message content.

## Account hygiene

- Pair from an **incognito window** (or Firefox/Safari) and close it
  afterwards: Chrome 146+ device-bound sessions cannot be rotated by this
  client and are refused up front; a second consumer of the same login races
  rotation and gets refused with `SESSION_COOKIE_INVALID`.
- The session stays alive only while the listener keeps running. An idle
  session dies within hours; disconnect removes local state and stops
  rotation. The Google account itself is untouched — disconnecting never
  deletes Google-side devices or data.
- Google's terms may prohibit automated access. This plugin never circumvents
  a sign-in check; acquiring cookies is a deliberate manual step.

## Reporting

For security issues, open a private report on the repository rather than a
public issue.
