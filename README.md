# dsh-sms

SMS/RCS for DeepSeek Harness over your phone's real number, via Google Messages
for Web. Pair your phone once, save the numbers you trust, and every 1:1 text
from those numbers becomes a DSH prompt — with DSH's final answer sent back as
SMS.

The plugin is built on [gmessages](https://www.npmjs.com/package/gmessages), a
TypeScript protocol client for Google Messages for Web whose wire shapes are
verified against Google's own descriptors.

## How it works

```
other phone ──SMS/RCS──▶ your phone (Google Messages)
                              │ (messages.google.com relay)
                              ▼
                        dsh-sms listener (local DSH host)
                              │  inbound text → DSH prompt
                              ▼
                       DeepSeek Harness session
                              │  final answer → SMS/RCS
                              ▼
                        dsh-sms listener → your phone → other phone
```

- The listener runs on the DSH host (your Mac) and keeps a long-lived
  connection to the Google Messages relay. That connection is what keeps the
  session alive: while it runs, cookies and tokens rotate and the session
  survives. Left idle, a session dies within hours.
- Only **1:1 conversations from authorized numbers** are accepted. Group
  chats, media-only messages, and your own sends are ignored.
- DSH replies are converted to plain text and split at grapheme boundaries
  (≤ 3,500 characters per chunk, matching SMS limits). Code blocks keep their
  exact contents.
- Typing indicators are shown while a DSH turn runs.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or compatible (`0.1.0-rc.8` verified)
- Node.js `^22.19 || >=24`
- A Google account signed in to Google Messages on your phone
- The phone must stay online; pairing requires confirming a code on the handset

## Install

```sh
dsh plugin --profile web add dsh-sms
```

Restart `dsh web`, then open **Settings → SMS**.

For a local checkout:

```sh
npm ci --legacy-peer-deps
npm run build
npm pack
dsh plugin --profile web add ./dsh-sms-*.tgz
```

## Setup (three steps)

1. **Authorize numbers.** Enter the E.164 numbers whose texts should become
   DSH prompts, one per line, and save.
2. **Pair with your phone.** Sign in to `messages.google.com` in an
   **incognito window** (Firefox/Safari avoid Chrome's device-bound sessions),
   export its cookies (a cookie-export extension, or DevTools → Application →
   Cookies), paste them, and click **Start pairing**. Google Messages on your
   phone shows a pairing prompt with a code — approve it. The plugin stores the
   resulting session in the DSH credential store and discards the cookies.
3. **Text your number.** From any authorized number, send a text to your phone
   number. It arrives as a DSH prompt; the final answer comes back as SMS.

The listener status (listening / reconnecting / failed), the active DSH
session, and Disconnect/Retry controls are on the same settings page.

## Commands

Ordinary text is queued as a DSH prompt. Prefix a prompt that genuinely begins
with `/` using `//`, e.g. `//review this route`.

| Command | Behavior |
|---|---|
| `/help` | Show command help. |
| `/new` | Create and select a new root session. |
| `/sessions [page]` | List same-workspace root sessions, five per page. |
| `/switch <index\|session-id>` | Select a session by index, exact ID, or unique prefix. |
| `/status` | Show the active session and its state. |
| `/stop` or `/cancel` | Stop the running turn and invalidate queued prompts. |
| `/approve <request-id>` | Allow one approval request correlated to the SMS turn. |
| `/deny <request-id>` | Deny a correlated approval request. |
| `/answer <request-id> <option-or-text>` | Answer a correlated question; commas select multiple choices. |

New sessions use the `dsh web` working directory, the default Agent Preset,
and the current default model. Session switching is refused while a prompt is
queued or an interaction is pending — send `/stop` first.

## Security

The session document holds account-wide Google credentials; it lives only in
the DSH credential store. Cookies are used once during pairing and discarded.
Message text and phone numbers are never logged. Only authorized 1:1
conversations are routed. See [SECURITY.md](SECURITY.md) for the full
boundaries.

## Configuration

Defaults are host-only and are not exposed in the settings page:

| Option | Default |
|---|---:|
| `interactionTimeoutMs` | `600000` (10 minutes) |
| `maxOutboundChars` | `3500` graphemes |
| `sessionsPerPage` | `5` |
| `dedupeEntries` | `1024` |
| `reconnectMinMs` | `1000` |
| `reconnectMaxMs` | `60000` |

Override the bundle row in the web profile's `cordis.patch.yml`. DSH patch
overrides replace the complete row, so preserve both `id` and `name`:

```yaml
- id: dsh-sms
  name: dsh-sms
  config:
    interactionTimeoutMs: 900000
    maxOutboundChars: 3000
```

## Troubleshooting

| Error | Action |
|---|---|
| `invalid-phone` | Enter `+`, a non-zero country-code digit, and at most 15 total digits. |
| `invalid-cookies` | Paste a Netscape/JSON cookie export from `messages.google.com`. |
| `dbsc-session-refused` | The export is from a device-bound Chrome session; use an incognito window or Firefox/Safari. |
| `pairing-expired` | Start again and approve on the phone within the relay's window. |
| `pairing-denied` | The phone did not approve the pairing request. |
| `session-dead` | The stored session is stale or invalid; disconnect and pair again. |
| `settings-conflict` | Another window changed settings; refresh and retry. |
| `credential-readonly` / `settings-readonly` | Remove the higher-priority read-only DSH override. |

## Limitations

- One Google account/session per plugin instance.
- Text-only 1:1 conversations. Attachments, reactions, group chats, and
  typing-state events are ignored (media is not forwarded to DSH).
- SMS cannot report delivery: a send that reaches the relay is `accepted`;
  there is no read receipt on SMS threads (RCS threads may report more).
- The session must stay connected to keep rotating; a long-idle session dies
  and requires re-pairing.
- Google's terms may prohibit automated access to Messages for Web; acquiring
  the cookie export is a deliberate manual step.

## Development

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack --dry-run
# With a dsh binary available:
DSH_BIN=/path/to/dsh npm run test:profile
```

The test suite is fully reproducible from npm: `@deepseek-ai/*` packages are
pinned at `0.1.0-rc.6` in `devDependencies` (npm registry), and the plugin's
whole CI pipeline — test, build, prod-dependency audit, pack, and a disposable
DSH web-profile installation — runs against them without any local dsh
install. At runtime the plugin runs against whatever dsh provides (the peer
range allows rc.6–rc.8). See `.github/workflows/ci.yml`.

The suite covers inbound policy, number matching, supervisor reconnect
backoff, replay deduplication, pairing error classification, turn ownership,
interaction fail-closed behavior, chunking, plaintext conversion, and the
settings UI. CI runs the suite, packed-artifact checks, and a disposable DSH
web-profile installation.

## License

MIT
