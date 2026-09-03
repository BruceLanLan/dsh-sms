import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  SmsPluginState,
  PublicPluginError,
  RuntimeView,
} from '../types.js'
import type { SmsSettingsController } from './controller.js'

/** Dependencies supplied by the client slot registration. */
export interface SmsSettingsInjected {
  controller: SmsSettingsController
}

/** Slot props are partial until the renderer has resolved every injected seat. */
export type SmsSettingsSectionProps = Partial<SmsSettingsInjected & SettingsSectionOwnerProps>

/** Render the complete Google Messages SMS setup surface. */
export function SmsSettingsSection(props: SmsSettingsSectionProps): ReactNode {
  if (props.controller === undefined) return null
  return <Loaded controller={props.controller} />
}

function Loaded({ controller }: SmsSettingsInjected): ReactNode {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  if (snapshot.state === undefined) {
    return (
      <section className="dsh-sms-section" aria-busy={snapshot.phase === 'loading'}>
        <PageHeader />
        {snapshot.error === undefined
          ? <p className="dsh-sms-muted">Loading SMS configuration…</p>
          : <ErrorNotice error={snapshot.error} onRetry={() => { void controller.refresh() }} />}
      </section>
    )
  }

  const paired = snapshot.state.credentialConfigured
  return (
    <section className="dsh-sms-section" aria-busy={snapshot.pendingAction !== undefined}>
      <PageHeader />
      {snapshot.error === undefined ? null : <ErrorNotice error={snapshot.error} />}
      <NumbersCard controller={controller} state={snapshot.state} pending={snapshot.pendingAction} />
      <PairingCard controller={controller} state={snapshot.state} pending={snapshot.pendingAction} />
      {paired ? (
        <StatusCard controller={controller} state={snapshot.state} pending={snapshot.pendingAction} />
      ) : null}
      <p className="dsh-sms-footnote">
        Only 1:1 SMS/RCS conversations from your authorized numbers become DSH prompts; group chats, media,
        and your own sends are ignored. The Google session and message text never leave the local host and
        are never written to plugin logs. The session stays alive only while the listener keeps running.
      </p>
    </section>
  )
}

function PageHeader(): ReactNode {
  return (
    <header className="dsh-sms-heading">
      <div>
        <p className="dsh-sms-eyebrow">Google Messages transport</p>
        <h1>SMS</h1>
        <p>Pair your phone’s Google Messages and route SMS to DeepSeek Harness.</p>
      </div>
    </header>
  )
}

function NumbersCard({
  controller,
  state,
  pending,
}: {
  controller: SmsSettingsController
  state: SmsPluginState
  pending: string | undefined
}): ReactNode {
  const [text, setText] = useState((state.authorizedNumbers ?? []).join('\n'))
  const [dirty, setDirty] = useState(false)
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const valid = lines.every(isStrictE164)
  const saved = (state.authorizedNumbers ?? []).join('\n')

  useEffect(() => {
    if (!dirty) setText(saved)
  }, [dirty, saved])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!valid || lines.length === 0) return
    void controller.saveNumbers(lines, state.revision).then((result) => {
      if (result?.ok === true) setDirty(false)
    })
  }

  return (
    <article className="dsh-sms-card">
      <CardTitle
        number="1"
        title="Authorize numbers"
        status={state.authorizedNumbers === undefined || state.authorizedNumbers.length === 0
          ? 'Not configured' : `${state.authorizedNumbers.length} configured`}
      />
      <p className="dsh-sms-body">
        Enter the E.164 phone numbers whose 1:1 texts with your phone become DSH prompts, one per line.
      </p>
      <form className="dsh-sms-form" onSubmit={submit}>
        <label htmlFor="dsh-sms-numbers">Authorized peer numbers</label>
        <textarea
          id="dsh-sms-numbers"
          rows={3}
          spellCheck={false}
          placeholder={'+14155552671\n+8613800138000'}
          value={text}
          aria-invalid={text.length > 0 && !valid}
          disabled={pending !== undefined}
          onChange={(event) => {
            setText(event.currentTarget.value)
            setDirty(true)
          }}
        />
        {text.length > 0 && !valid ? (
          <p className="dsh-sms-error">Every line must be a full E.164 number: “+” followed by 2–15 digits.</p>
        ) : null}
        <div className="dsh-sms-actions">
          <button
            type="submit"
            className="dsh-sms-button dsh-sms-primary"
            disabled={!valid || lines.length === 0 || pending !== undefined || !state.settingsWritable}
          >
            {pending === 'save-numbers' ? 'Saving…' : 'Save numbers'}
          </button>
        </div>
      </form>
    </article>
  )
}

function PairingCard({
  controller,
  state,
  pending,
}: {
  controller: SmsSettingsController
  state: SmsPluginState
  pending: string | undefined
}): ReactNode {
  const pairing = state.pairing
  const [cookies, setCookies] = useState('')
  const canMutate = state.settingsWritable && state.credentialWritable && pending === undefined

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (cookies.trim().length === 0) return
    void controller.beginPairing(cookies, state.revision)
  }

  return (
    <article className="dsh-sms-card">
      <CardTitle number="2" title="Pair with your phone" status={pairingLabel(pairing)} />
      {pairing.phase === 'paired' ? (
        <p className="dsh-sms-body">
          Paired at {new Date(pairing.pairedAt).toLocaleString()}. Texts from your authorized numbers are
          routed as DSH prompts. Use the Listener card below to disconnect.
        </p>
      ) : pairing.phase === 'pairing' ? (
        <div className="dsh-sms-device" aria-live="polite">
          <span className="dsh-sms-label">Verification code</span>
          <strong className="dsh-sms-code">
            {pairing.emoji === null ? pairing.numeric : `${pairing.emoji} ${pairing.numeric}`}
          </strong>
          <p className="dsh-sms-body">
            Approve the matching pairing prompt inside Google Messages on your phone. The attempt expires
            after a few minutes.
          </p>
          <div className="dsh-sms-actions">
            <button
              type="button"
              className="dsh-sms-button"
              disabled={pending !== undefined}
              onClick={() => { void controller.cancelPairing() }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : pairing.phase === 'failed' ? (
        <>
          <ErrorNotice error={pairing.error} />
          <div className="dsh-sms-actions">
            <button
              type="button"
              className="dsh-sms-button dsh-sms-primary"
              disabled={!canMutate}
              onClick={() => { setCookies('') }}
            >
              Start over
            </button>
          </div>
        </>
      ) : (
        <form className="dsh-sms-form" onSubmit={start}>
          <p className="dsh-sms-body">
            Sign in to <code>messages.google.com</code> in an <strong>incognito window</strong> (Firefox or
            Safari avoid Chrome’s device-bound sessions), export its cookies, and paste them here. Use a
            cookie-export extension or DevTools → Application → Cookies. Close the window afterwards so only
            this plugin rotates the login.
          </p>
          <label htmlFor="dsh-sms-cookies">Google Messages cookies</label>
          <textarea
            id="dsh-sms-cookies"
            rows={5}
            spellCheck={false}
            placeholder={'Paste the Netscape/JSON cookie export here'}
            value={cookies}
            disabled={pending !== undefined}
            onChange={(event) => { setCookies(event.currentTarget.value) }}
          />
          <div className="dsh-sms-actions">
            <button
              type="submit"
              className="dsh-sms-button dsh-sms-primary"
              disabled={cookies.trim().length === 0 || pending !== undefined || !canMutate}
            >
              {pending === 'pair' ? 'Pairing…' : 'Start pairing'}
            </button>
          </div>
        </form>
      )}
      {!state.settingsWritable || !state.credentialWritable ? (
        <p className="dsh-sms-warning">
          This profile is read-only. Remove the settings or credential override before changing setup.
        </p>
      ) : null}
    </article>
  )
}

function StatusCard({
  controller,
  state,
  pending,
}: {
  controller: SmsSettingsController
  state: SmsPluginState
  pending: string | undefined
}): ReactNode {
  const disconnect = (): void => {
    if (!window.confirm('Disconnect local SMS routing? The Google session will be removed.')) return
    void controller.disconnect(state.revision)
  }

  return (
    <article className="dsh-sms-card">
      <CardTitle number="3" title="Listener" status={runtimeLabel(state.runtime)} />
      <dl className="dsh-sms-health">
        <div><dt>Listener</dt><dd>{runtimeLabel(state.runtime)}</dd></div>
        <div><dt>Active session</dt><dd>{state.activeSessionId ?? 'A new session will be created'}</dd></div>
      </dl>
      {state.runtime.phase === 'failed' ? <ErrorNotice error={state.runtime.error} /> : null}
      {state.runtime.phase === 'retrying' ? (
        <p className="dsh-sms-muted">
          Reconnect attempt {state.runtime.attempt} is scheduled for {formatTime(state.runtime.retryAt)}.
          The session must stay connected to keep rotating; an idle session dies within hours.
        </p>
      ) : null}
      <div className="dsh-sms-actions">
        {state.runtime.phase === 'failed' || state.runtime.phase === 'stopped' ? (
          <button
            type="button"
            className="dsh-sms-button"
            disabled={pending !== undefined}
            onClick={() => { void controller.retryRuntime() }}
          >
            {pending === 'retry-runtime' ? 'Starting…' : 'Retry listener'}
          </button>
        ) : null}
        <button
          type="button"
          className="dsh-sms-button dsh-sms-danger"
          disabled={pending !== undefined || !state.settingsWritable || !state.credentialWritable}
          onClick={disconnect}
        >
          {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
      <CommandReference />
    </article>
  )
}

function CardTitle({ number, title, status }: { number: string; title: string; status: string }): ReactNode {
  return (
    <div className="dsh-sms-card-title">
      <div><span>{number}</span><h2>{title}</h2></div>
      <small>{status}</small>
    </div>
  )
}

function CommandReference(): ReactNode {
  const commands = [
    ['/help', 'Show command help'],
    ['/new', 'Start a new DSH session'],
    ['/sessions [page]', 'List same-workspace root sessions'],
    ['/switch <index|session-id>', 'Change the active session'],
    ['/status', 'Show listener and session status'],
    ['/stop or /cancel', 'Stop the active turn'],
    ['/approve <request-id>', 'Approve a correlated request once'],
    ['/deny <request-id>', 'Deny a correlated request'],
    ['/answer <request-id> <answer>', 'Answer a correlated question'],
    ['//text', 'Send a normal prompt beginning with /'],
  ] as const
  return (
    <details className="dsh-sms-commands">
      <summary>Command reference</summary>
      <dl>
        {commands.map(([command, description]) => (
          <div key={command}><dt><code>{command}</code></dt><dd>{description}</dd></div>
        ))}
      </dl>
      <p>Session switching and creation are refused during a turn or human interaction; send <code>/stop</code> first.</p>
    </details>
  )
}

function ErrorNotice({ error, onRetry }: { error: PublicPluginError; onRetry?: () => void }): ReactNode {
  return (
    <div className="dsh-sms-error-box" role="alert">
      <strong>{error.message}</strong>
      {error.details === undefined || error.details.length === 0 ? null : (
        <ul>{error.details.map(detail => <li key={detail}><code>{detail}</code></li>)}</ul>
      )}
      {onRetry === undefined ? null : (
        <button type="button" className="dsh-sms-button" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}

function pairingLabel(pairing: SmsPluginState['pairing']): string {
  switch (pairing.phase) {
    case 'paired': return 'Paired'
    case 'pairing': return 'Waiting for phone approval'
    case 'awaiting-cookies': return 'Pairing'
    case 'failed': return 'Pairing failed'
    case 'idle': return 'Not paired'
  }
}

function runtimeLabel(runtime: RuntimeView): string {
  switch (runtime.phase) {
    case 'listening': return 'Listening'
    case 'starting': return 'Starting'
    case 'retrying': return `Reconnecting (${runtime.attempt})`
    case 'failed': return 'Listener failed'
    case 'stopped': return 'Stopped'
  }
}

function isStrictE164(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/u.test(value)
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}
