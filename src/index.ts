import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  settingsNamespace,
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsScope,
} from '@deepseek-ai/dsh-settings'
import {
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  Config as ConfigSchema,
  PluginSettingsSchema,
  resolveConfig,
  type Config,
  type PluginSettings,
  type ResolvedConfig,
} from './config.js'
import { CREDENTIAL_NAME, PLUGIN_ID, SETTINGS_NAME } from './constants.js'
import {
  parseSmsCredential,
  serializeSmsCredential,
  type SmsCredential,
} from './credential.js'
import { rememberInbound } from './dedupe.js'
import { PluginError, publicError } from './errors.js'
import {
  createGmessagesConnection,
  SmsSupervisor,
  type SmsInboundMessage,
} from './gmessages-runtime.js'
import { normalizeE164 } from './phone.js'
import { pairWithGoogle, type PairWithGoogleOptions } from './pairing.js'
import { SessionRouter } from './session-router.js'
import { pluginDomainSpec } from './storage.js'
import type {
  BeginPairingRequest,
  DisconnectRequest,
  MutationResult,
  PairingView,
  PublicPluginError,
  RuntimeView,
  SaveNumbersRequest,
  SmsPluginState,
} from './types.js'

export type * from './types.js'
export { normalizeE164 } from './phone.js'
export { chunkText } from './chunks.js'
export { rememberInbound } from './dedupe.js'
export { acceptsInboundMessage, numbersMatch } from './gmessages-runtime.js'
export { parseCommand } from './commands.js'
export { presetForResume, selectionForResume } from './session-selection.js'
export { parseQuestionAnswer } from './question-answer.js'
export { TurnCorrelation } from './turn-correlation.js'
export { pairWithGoogle, classifyPairingError } from './pairing.js'

/** Cordis plugin name. */
export const name = 'dsh-sms'

/** Required DSH host services. */
export const inject = [
  'settings',
  'credentials',
  'storageDomain',
  'agents',
  'sessions',
  'sessionPersistence',
  'agentPresets',
  'agentDefaultModel',
  'tools',
  'approval',
  'userQuestions',
]

/** DSH non-secret settings namespace. */
export const SETTINGS_NAMESPACE = settingsNamespace(SETTINGS_NAME)

/** Opaque Google Messages session credential reference. */
export const GOOGLE_CREDENTIAL_REF = credentialRef(CREDENTIAL_NAME)

type PluginDomain = Domain<typeof pluginDomainSpec>
type InboundTable = KvTable<string, { receivedAt: number }>

/** Host service implementing Google Messages pairing, routing, and typed RPC. */
export class DshSmsService extends TypertRemoteService {
  static inject = inject
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private settingsScope?: SettingsScope<PluginSettings>
  private domain?: PluginDomain
  private inbound?: InboundTable
  private router?: SessionRouter
  private supervisor?: SmsSupervisor
  private pairingOverride: PairingView = { phase: 'idle' }
  private runtime: RuntimeView = { phase: 'stopped' }
  private pairingController: AbortController | undefined
  private pairingTask: Promise<void> | undefined
  private pairingGeneration = 0
  private pairingTail = Promise.resolve()
  private inboundTail = Promise.resolve()

  /** Construct the host service; async resources open in Service.init. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dshSms')
    this.config = resolveConfig(config)
  }

  /** Register settings, open durable state, and resume local routing. */
  protected async [Service.init](): Promise<void> {
    this.settingsScope = this.ctx.settings.register(SETTINGS_NAMESPACE, PluginSettingsSchema, {
      applies: 'live',
      validate: validateSettings,
    })
    const domain = await this.ctx.storageDomain.open(pluginDomainSpec)
    this.domain = domain
    this.inbound = domain.table('inbound')

    const router = new SessionRouter(this.ctx, {
      get: () => domain.global.get().activeSessionId,
      set: async activeSessionId => {
        await domain.global.set(activeSessionId === undefined ? {} : { activeSessionId })
      },
    }, {
      cwd: process.cwd(),
      sessionsPerPage: this.config.sessionsPerPage,
      maxOutboundChars: this.config.maxOutboundChars,
      interactionTimeoutMs: this.config.interactionTimeoutMs,
    })
    this.router = router

    const supervisor = new SmsSupervisor(createGmessagesConnection, {
      reconnectMinMs: this.config.reconnectMinMs,
      reconnectMaxMs: this.config.reconnectMaxMs,
      onState: state => {
        this.runtime = state
        router.setRuntimeHealthy(state.phase === 'listening')
      },
      onMessage: message => this.receiveSmsMessage(message),
    })
    this.supervisor = supervisor

    const credential = await this.resolveCredential()
    if (credential !== undefined) {
      this.pairingOverride = { phase: 'paired', pairedAt: Date.now() }
      const settings = this.requireSettings().get()
      if (settings.authorizedNumbers !== undefined && settings.authorizedNumbers.length > 0) {
        void supervisor.restart(this.supervisorConfig(credential))
      }
    }

    this.ctx.effect(() => async () => {
      this.pairingGeneration += 1
      this.pairingController?.abort(new DOMException('Plugin stopped', 'AbortError'))
      await supervisor.stop()
      await this.inboundTail.catch(() => {})
      await router.close()
      await domain.close()
    }, 'dsh-sms.teardown')
  }

  /** Read the complete redacted settings-page state. */
  @Remote('getState')
  async getState(): Promise<SmsPluginState> {
    const descriptor = this.settingsDescriptor()
    const credentialInfo = await this.ctx.credentials.describe(GOOGLE_CREDENTIAL_REF)
    const settings = this.requireSettings().get()
    const activeSessionId = this.requireDomain().global.get().activeSessionId
    return {
      revision: descriptor.revision,
      settingsWritable: this.ctx.settings.writable,
      credentialConfigured: credentialInfo.configured,
      credentialWritable: credentialInfo.writable,
      pairing: this.pairingOverride,
      runtime: this.runtime,
      ...(settings.authorizedNumbers === undefined ? {} : { authorizedNumbers: [...settings.authorizedNumbers] }),
      ...(activeSessionId === undefined ? {} : { activeSessionId }),
    }
  }

  /** Save the authorized E.164 peer numbers and restart routing when paired. */
  @Remote('saveNumbers')
  async saveNumbers(request: SaveNumbersRequest): Promise<MutationResult> {
    return this.mutation(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      const authorizedNumbers = normalizeNumbers(request.authorizedNumbers)
      await this.ctx.settings.update(SETTINGS_NAMESPACE, { authorizedNumbers }, request.expectedRevision)
      const credential = await this.resolveCredential()
      if (credential !== undefined) {
        await this.requireSupervisor().restart(this.supervisorConfig(credential))
      }
    })
  }

  /** Start Google Messages pairing from a pasted cookie export. */
  @Remote('beginPairing')
  async beginPairing(request: BeginPairingRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueuePairing(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      if (this.pairingTask !== undefined && this.pairingController === undefined) {
        throw new PluginError('busy', 'Pairing is already completing; refresh to see the result.')
      }
      this.cancelPairingInternal()
      const generation = ++this.pairingGeneration
      const controller = new AbortController()
      this.pairingController = controller
      this.pairingOverride = { phase: 'awaiting-cookies' }

      const options: PairWithGoogleOptions = {
        cookies: request.cookies,
        signal: controller.signal,
        callbacks: {
          onVerification: prompt => {
            if (generation !== this.pairingGeneration) return
            this.pairingOverride = {
              phase: 'pairing',
              emoji: prompt.emoji,
              numeric: prompt.numeric,
            }
          },
        },
      }
      const session = await pairWithGoogle(options)
      if (generation !== this.pairingGeneration || controller.signal.aborted) return
      this.pairingController = undefined

      const oldCredential = (await this.ctx.credentials.resolve(GOOGLE_CREDENTIAL_REF))?.value
      const nextSettings = this.requireSettings().get()
      const credential: SmsCredential = { version: 1, session }
      try {
        await this.ctx.credentials.set(GOOGLE_CREDENTIAL_REF, serializeSmsCredential(credential))
        // Even a pairing with no numbers performs an empty settings write so the
        // optimistic revision is checked at the serialized write boundary.
        await this.ctx.settings.update(SETTINGS_NAMESPACE, nextSettings, request.expectedRevision)
      } catch (error) {
        if (oldCredential === undefined) await this.ctx.credentials.unset(GOOGLE_CREDENTIAL_REF)
        else await this.ctx.credentials.set(GOOGLE_CREDENTIAL_REF, oldCredential)
        throw error
      }
      this.pairingOverride = { phase: 'paired', pairedAt: Date.now() }
      if (nextSettings.authorizedNumbers !== undefined && nextSettings.authorizedNumbers.length > 0) {
        await this.requireSupervisor().restart(this.supervisorConfig(credential))
      }
    }))
  }

  /** Cancel an in-progress pairing attempt without disturbing the working config. */
  @Remote('cancelPairing')
  async cancelPairing(): Promise<MutationResult> {
    return this.mutation(async () => {
      this.cancelPairingInternal()
    })
  }

  /** Clear local routing, pairing, and credentials while preserving nothing remote. */
  @Remote('disconnect')
  async disconnect(request: DisconnectRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueuePairing(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      this.cancelPairingInternal()
      const oldCredential = (await this.ctx.credentials.resolve(GOOGLE_CREDENTIAL_REF))?.value
      await this.ctx.credentials.unset(GOOGLE_CREDENTIAL_REF)
      try {
        await this.ctx.settings.replace(SETTINGS_NAMESPACE, {}, request.expectedRevision)
      } catch (error) {
        if (oldCredential !== undefined) await this.ctx.credentials.set(GOOGLE_CREDENTIAL_REF, oldCredential)
        throw error
      }

      await this.requireSupervisor().stop()
      await this.inboundTail.catch(() => {})
      await this.requireRouter().reset()
      const table = this.requireInboundTable()
      for (const key of [...table.keys()]) await table.delete(key)
      this.pairingOverride = { phase: 'idle' }
      this.runtime = { phase: 'stopped' }
    }))
  }

  /** Retry the listener using the currently stored session and numbers. */
  @Remote('retryRuntime')
  async retryRuntime(): Promise<MutationResult> {
    return this.mutation(async () => {
      const credential = await this.resolveCredential()
      const settings = this.requireSettings().get()
      if (credential === undefined || settings.authorizedNumbers === undefined || settings.authorizedNumbers.length === 0) {
        throw new PluginError('runtime-failed', 'Pair Google Messages and save authorized numbers before retrying.')
      }
      await this.requireSupervisor().restart(this.supervisorConfig(credential))
    })
  }

  private supervisorConfig(credential: SmsCredential): Parameters<SmsSupervisor['restart']>[0] {
    const numbers = this.requireSettings().get().authorizedNumbers ?? []
    return {
      loadSession: async () => {
        const current = await this.resolveCredential()
        return current?.session
      },
      onSessionUpdate: async session => {
        await this.ctx.credentials.set(GOOGLE_CREDENTIAL_REF, serializeSmsCredential({ version: 1, session }))
      },
      authorizedNumbers: numbers,
    }
  }

  private async receiveSmsMessage(message: SmsInboundMessage): Promise<void> {
    const result = this.inboundTail.then(async () => {
      const table = this.requireInboundTable()
      if (!await rememberInbound(table, message.id, this.config.dedupeEntries)) return
      await this.requireRouter().receive(message)
    })
    this.inboundTail = result.catch(() => {})
    return result
  }

  private async resolveCredential(): Promise<SmsCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(GOOGLE_CREDENTIAL_REF)
    if (resolved === undefined) return undefined
    try {
      return parseSmsCredential(resolved.value)
    } catch {
      const error = publicError(new PluginError(
        'session-dead',
        'The stored Google Messages session is invalid. Disconnect and pair again.',
      ))
      this.pairingOverride = { phase: 'failed', error }
      return undefined
    }
  }

  private async requireWritablePlanes(): Promise<void> {
    if (!this.ctx.settings.writable) {
      throw new PluginError('settings-readonly', 'The active DSH settings provider is read-only.')
    }
    const info = await this.ctx.credentials.describe(GOOGLE_CREDENTIAL_REF)
    if (!info.writable) {
      throw new PluginError(
        'credential-readonly',
        'The Google Messages credential is supplied by a read-only source. Remove that override before changing SMS setup.',
      )
    }
  }

  private cancelPairingInternal(): void {
    const controller = this.pairingController
    if (controller !== undefined) {
      this.pairingGeneration += 1
      controller.abort(new DOMException('Pairing cancelled', 'AbortError'))
      this.pairingController = undefined
    }
    if (this.pairingOverride.phase === 'pairing' || this.pairingOverride.phase === 'failed') {
      this.pairingOverride = { phase: 'idle' }
    }
  }

  private assertRevision(expected: number): void {
    const actual = this.settingsDescriptor().revision
    if (actual !== expected) throw new SettingsConflictError(SETTINGS_NAMESPACE, expected, actual)
  }

  private enqueuePairing<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pairingTail.then(operation, operation)
    this.pairingTail = result.then(() => {}, () => {})
    return result
  }

  private async mutation(operation: () => Promise<void> | void): Promise<MutationResult> {
    try {
      await operation()
      return { ok: true, state: await this.getState() }
    } catch (error) {
      return { ok: false, error: publicError(error), state: await this.getState() }
    }
  }

  private settingsDescriptor(): SettingsDescriptor {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('dsh-sms settings are not registered')
    return descriptor
  }

  private requireSettings(): SettingsScope<PluginSettings> {
    if (this.settingsScope === undefined) throw new Error('dsh-sms settings are not initialized')
    return this.settingsScope
  }

  private requireDomain(): PluginDomain {
    if (this.domain === undefined) throw new Error('dsh-sms storage is not initialized')
    return this.domain
  }

  private requireInboundTable(): InboundTable {
    if (this.inbound === undefined) throw new Error('dsh-sms dedupe storage is not initialized')
    return this.inbound
  }

  private requireRouter(): SessionRouter {
    if (this.router === undefined) throw new Error('dsh-sms router is not initialized')
    return this.router
  }

  private requireSupervisor(): SmsSupervisor {
    if (this.supervisor === undefined) throw new Error('dsh-sms supervisor is not initialized')
    return this.supervisor
  }
}

function normalizeNumbers(input: readonly string[]): string[] {
  const values = [...new Set(input.map(normalizeE164))]
  if (values.length === 0) {
    throw new PluginError('invalid-phone', 'Save at least one authorized E.164 number.')
  }
  return values
}

function validateSettings(settings: PluginSettings): void {
  if (settings.authorizedNumbers === undefined) return
  for (const number of settings.authorizedNumbers) normalizeE164(number)
}

export default DshSmsService
