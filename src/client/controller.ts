import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SmsPluginState,
  MutationResult,
  PublicPluginError,
} from '../types.js'
// Pulls the generated namespace declaration into TypertClientRemote.
import type {} from 'dsh-sms/remote'

type SmsRemote = TypertClientRemote['dshSms']

/** Browser-only load and mutation state for the settings section. */
export interface SmsClientSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  state?: SmsPluginState
  pendingAction?: 'pair' | 'cancel-pair' | 'save-numbers' | 'disconnect' | 'retry-runtime'
  error?: PublicPluginError
}

type Listener = () => void

/** Minimal observable controller injected into the React settings slot. */
export class SmsSettingsController {
  private snapshot: SmsClientSnapshot = { phase: 'idle' }
  private readonly listeners = new Set<Listener>()
  private refreshTask: Promise<SmsPluginState | undefined> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private mutationGeneration = 0

  constructor(private readonly remote: SmsRemote) {}

  /** Stable uSES snapshot read. */
  getSnapshot = (): SmsClientSnapshot => this.snapshot

  /** Start refresh polling only while a settings surface is mounted. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.schedulePoll()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.clearPoll()
    }
  }

  /** Read a fresh public projection from the host. */
  refresh(): Promise<SmsPluginState | undefined> {
    if (this.snapshot.pendingAction !== undefined) return Promise.resolve(this.snapshot.state)
    if (this.refreshTask !== undefined) return this.refreshTask
    if (this.snapshot.state === undefined) this.publish({ phase: 'loading' })
    const generation = this.mutationGeneration
    const task = this.remote.getState()
      .then((result) => {
        if (generation !== this.mutationGeneration) return this.snapshot.state
        if (!result.ok) throw new RemoteTransportError()
        this.publish({ phase: 'ready', state: result.value })
        return result.value
      })
      .catch(() => {
        if (generation !== this.mutationGeneration) return this.snapshot.state
        this.publish({
          phase: 'error',
          ...(this.snapshot.state === undefined ? {} : { state: this.snapshot.state }),
          error: connectionError(),
        })
        return undefined
      })
      .finally(() => {
        if (this.refreshTask === task) this.refreshTask = undefined
        this.schedulePoll()
      })
    this.refreshTask = task
    return task
  }

  /** Start Google Messages pairing from a pasted cookie export. */
  beginPairing(cookies: string, expectedRevision: number): Promise<MutationResult | undefined> {
    return this.mutate('pair', () => this.remote.beginPairing({ cookies, expectedRevision }))
  }

  /** Cancel an in-progress pairing attempt. */
  cancelPairing(): Promise<MutationResult | undefined> {
    return this.mutate('cancel-pair', () => this.remote.cancelPairing())
  }

  /** Save the authorized peer numbers and restart routing when paired. */
  saveNumbers(authorizedNumbers: string[], expectedRevision: number): Promise<MutationResult | undefined> {
    return this.mutate('save-numbers', () => this.remote.saveNumbers({ authorizedNumbers, expectedRevision }))
  }

  /** Clear local configuration and the stored Google session. */
  disconnect(expectedRevision: number): Promise<MutationResult | undefined> {
    return this.mutate('disconnect', () => this.remote.disconnect({ expectedRevision }))
  }

  /** Restart the local Google Messages listener. */
  retryRuntime(): Promise<MutationResult | undefined> {
    return this.mutate('retry-runtime', () => this.remote.retryRuntime())
  }

  /** Release browser timers; the generated Remote contribution is owned by apply(). */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.clearPoll()
  }

  private async mutate(
    action: NonNullable<SmsClientSnapshot['pendingAction']>,
    operation: () => ReturnType<SmsRemote['beginPairing']>,
  ): Promise<MutationResult | undefined> {
    if (this.snapshot.pendingAction !== undefined) return undefined
    this.mutationGeneration += 1
    const previous = this.snapshot
    this.publish({
      phase: previous.state === undefined ? 'loading' : 'ready',
      ...(previous.state === undefined ? {} : { state: previous.state }),
      pendingAction: action,
    })
    try {
      const response = await operation()
      if (!response.ok) throw new RemoteTransportError()
      const result = response.value
      this.publish({
        phase: 'ready',
        state: result.state,
        ...(result.ok ? {} : { error: result.error }),
      })
      return result
    } catch {
      this.publish({
        phase: 'error',
        ...(previous.state === undefined ? {} : { state: previous.state }),
        error: connectionError(),
      })
      return undefined
    } finally {
      this.schedulePoll()
    }
  }

  private publish(snapshot: SmsClientSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private schedulePoll(): void {
    this.clearPoll()
    if (this.disposed || this.listeners.size === 0 || this.snapshot.pendingAction !== undefined) return
    const state = this.snapshot.state
    const transient = state?.pairing.phase === 'pairing'
      || state?.runtime.phase === 'starting'
      || state?.runtime.phase === 'retrying'
    this.pollTimer = setTimeout(() => { void this.refresh() }, transient ? 1_000 : 5_000)
  }

  private clearPoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }
}

class RemoteTransportError extends Error {}

function connectionError(): PublicPluginError {
  return {
    code: 'internal-error',
    message: 'The DSH host connection could not complete this request. Reconnect and try again.',
  }
}
