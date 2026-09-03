import {
  connect,
  createMessageTracker,
  getConversation,
  GOOGLE_ENDPOINTS,
  GOOGLE_WEB_API_KEY,
  isOwnMessage,
  messagesOf,
  participantsOf,
  sendMessage,
  setTyping,
  type Client,
  type ClientEvent,
  type DeathReason,
  type Endpoints,
  type InboundMessage,
  type OperationDispatcher,
  type RotationEvent,
} from 'gmessages'
import { PluginError } from './errors.js'
import type { RuntimeView } from './types.js'

/** Accepted inbound direct text message routed into a DSH prompt. */
export interface SmsInboundMessage {
  /** Durable provider message id. */
  id: string
  /** Plain inbound text. */
  text: string
  /** Run work while Google Messages shows a typing indicator. */
  responding<T>(callback: () => Promise<T>): Promise<T>
  /** Send one plain-text SMS/RCS reply to the same conversation. */
  send(text: string): Promise<void>
}

/** Why a connection ended. Permanent deaths need a new pairing; reconnecting cannot revive them. */
export interface SmsConnectionDeath {
  /** True when the stored session can no longer authenticate (dead jar, phone unpaired, account changed). */
  permanent: boolean
  /** Redacted, log-safe reason such as `jar-dead`, `unpaired`, or `stream-fatal:502`. */
  reason: string
}

/** Running Google Messages connection behind an injectable adapter seam. */
export interface SmsConnection {
  /** Accepted inbound direct text messages. */
  messages: AsyncIterable<SmsInboundMessage>
  /** Stop and release provider resources. */
  stop(): Promise<void>
  /** Resolve why the stream ended, or null after a clean stop. Absent means "unknown, treat as transient". */
  finished?(): Promise<SmsConnectionDeath | null>
}

/** Everything the transport factory needs to open one live connection. */
export interface SmsConnectionConfig {
  /** Load the latest serialized session blob; undefined means not paired. */
  loadSession(): Promise<string | undefined>
  /** Persist every session rotation so reconnects resume the live session. */
  onSessionUpdate(session: string): Promise<void>
  /** Authorized E.164 peer numbers whose DMs become DSH prompts. */
  authorizedNumbers: readonly string[]
  /** Network seam; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Relay seam; defaults to the production Google Messages endpoints. */
  endpoints?: Endpoints
  /** Public web-client API key; defaults to the production constant. */
  apiKey?: string
  /** Request-id source for tests. */
  newId?: () => string
  /**
   * Redacted one-line diagnostics (rotation outcomes, death reasons); never message text or numbers.
   * `debug` marks routine chatter such as successful rotation cycles.
   */
  onDiagnostic?: (message: string, level?: 'info' | 'debug') => void
}

/** Injectable Google Messages connection factory. */
export type SmsConnectionFactory = (config: SmsConnectionConfig) => Promise<SmsConnection>

/** Supervisor callbacks. */
export interface SmsSupervisorOptions {
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs: number
  /** Called for every public runtime transition. */
  onState(state: RuntimeView): void
  /** Called for every accepted inbound text message. */
  onMessage(message: SmsInboundMessage): Promise<void>
  /** Random source used for reconnect jitter. */
  random?: () => number
  /** Clock used for public state timestamps. */
  now?: () => number
}

/** Serialized stop/start lifecycle with bounded exponential reconnect. */
export class SmsSupervisor {
  private readonly random: () => number
  private readonly now: () => number
  private desired: SmsConnectionConfig | undefined
  private connection: SmsConnection | undefined
  private operation = Promise.resolve()
  private generation = 0
  private reconnectAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stateValue: RuntimeView = { phase: 'stopped' }

  /** Construct one listener supervisor. */
  constructor(
    private readonly factory: SmsConnectionFactory,
    private readonly options: SmsSupervisorOptions,
  ) {
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
  }

  /** Current public listener health. */
  get state(): RuntimeView {
    return this.stateValue
  }

  /** Whether interaction delivery is healthy enough to claim DSH prompts. */
  get healthy(): boolean {
    return this.stateValue.phase === 'listening'
  }

  /** Atomically replace the desired configuration and restart the listener. */
  restart(config: SmsConnectionConfig): Promise<void> {
    this.desired = { ...config }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Retry the current configuration immediately. */
  retry(): Promise<void> {
    if (this.desired === undefined) {
      return Promise.reject(new PluginError('runtime-failed', 'Pair Google Messages before starting SMS routing.'))
    }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Stop local routing while preserving the stored session. */
  stop(): Promise<void> {
    this.desired = undefined
    return this.enqueue(async () => {
      await this.stopCurrent(true)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation)
    this.operation = result.catch(() => {})
    return result
  }

  private async startCurrent(): Promise<void> {
    const config = this.desired
    if (config === undefined) {
      this.publish({ phase: 'stopped' })
      return
    }
    const generation = ++this.generation
    this.publish({ phase: 'starting' })
    try {
      const session = await config.loadSession()
      if (session === undefined) {
        // Nothing to connect without a paired session; a later pairing restart
        // supplies a session and starts the listener.
        this.publish({ phase: 'stopped' })
        return
      }
      const connection = await this.factory({ ...config })
      if (generation !== this.generation || this.desired === undefined) {
        await connection.stop()
        return
      }
      this.connection = connection
      this.reconnectAttempt = 0
      this.publish({ phase: 'listening', connectedAt: this.now() })
      void this.consume(connection, generation)
    } catch (error) {
      if (generation !== this.generation || this.desired === undefined) return
      const permanent = permanentConnectFailure(error)
      if (permanent !== undefined) this.publishDead(permanent)
      else this.scheduleReconnect(error)
    }
  }

  private async consume(connection: SmsConnection, generation: number): Promise<void> {
    try {
      for await (const message of connection.messages) {
        if (generation !== this.generation || connection !== this.connection) return
        try {
          await this.options.onMessage(message)
        } catch {
          // A DSH turn or outbound send failure must not terminate the receive stream.
        }
      }
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        const death = await connection.finished?.().catch(() => null) ?? null
        if (death?.permanent === true) await this.retireAsDead(connection, generation, death)
        else await this.retireAndReconnect(connection, generation, new Error('Google Messages stream ended'))
      }
    } catch (error) {
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, error)
      }
    }
  }

  private async retireAndReconnect(
    connection: SmsConnection,
    generation: number,
    error: unknown,
  ): Promise<void> {
    this.connection = undefined
    try {
      await connection.stop()
    } catch {
      // The failed stream is already fenced by identity and generation.
    }
    if (generation === this.generation && this.desired !== undefined) this.scheduleReconnect(error)
  }

  /** Retire a permanently dead connection: surface `session-dead`, keep `desired` so an explicit retry still works. */
  private async retireAsDead(
    connection: SmsConnection,
    generation: number,
    death: SmsConnectionDeath,
  ): Promise<void> {
    this.connection = undefined
    try {
      await connection.stop()
    } catch {
      // Already dead; nothing further to release.
    }
    if (generation === this.generation && this.desired !== undefined) this.publishDead(death.reason)
  }

  private publishDead(reason: string): void {
    this.reconnectAttempt = 0
    this.publish({
      phase: 'failed',
      error: {
        code: 'session-dead',
        message: `The Google Messages session is no longer valid (${reason}). Disconnect and pair again.`,
      },
    })
  }

  private scheduleReconnect(_error: unknown): void {
    if (this.desired === undefined) return
    const attempt = ++this.reconnectAttempt
    const exponential = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** Math.min(attempt - 1, 20),
    )
    const jittered = Math.max(1, Math.round(exponential * (0.75 + this.random() * 0.5)))
    const retryAt = this.now() + jittered
    this.publish({ phase: 'retrying', attempt, retryAt })
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.enqueue(() => this.startCurrent()).catch(() => {
        this.publish({
          phase: 'failed',
          error: { code: 'runtime-failed', message: 'The Google Messages listener could not restart.' },
        })
      })
    }, jittered)
  }

  private async stopCurrent(clearState: boolean): Promise<void> {
    this.generation += 1
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const connection = this.connection
    this.connection = undefined
    if (connection !== undefined) {
      try {
        await connection.stop()
      } catch {
        // Teardown remains best-effort; the generation gate prevents further routing.
      }
    }
    if (clearState) this.publish({ phase: 'stopped' })
  }

  private publish(state: RuntimeView): void {
    this.stateValue = state
    this.options.onState(state)
  }
}

/** Bounded single-consumer async queue bridging onEvent pushes into an async iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waits: Array<(value: IteratorResult<T>) => void> = []
  private ended = false

  /** Append one value; no-op after close. */
  push(value: T): void {
    if (this.ended) return
    const waiter = this.waits.shift()
    if (waiter !== undefined) {
      waiter({ value, done: false })
      return
    }
    this.items.push(value)
  }

  /** End the stream; pending and future reads resolve done. */
  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waits.splice(0)) waiter({ value: undefined, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.ended) return
      const value = await new Promise<IteratorResult<T>>(resolve => {
        this.waits.push(resolve)
      })
      if (value.done) return
      yield value.value as T
    }
  }
}

/** Per-conversation facts needed to authorize and reply: own id and the peer number. */
export interface ConversationFacts {
  ownParticipantId: string
  peerNumber: string
}

/** Resolve and cache 1:1 conversation facts; non-DM or unresolvable rosters become undefined. */
function factsForConversation(
  dispatcher: OperationDispatcher,
  conversationId: string,
  cache: Map<string, Promise<ConversationFacts | undefined>>,
): Promise<ConversationFacts | undefined> {
  let pending = cache.get(conversationId)
  if (pending === undefined) {
    pending = getConversation(dispatcher, conversationId)
      .then(conversation => {
        const participants = participantsOf(conversation)
        const me = participants.filter(participant => participant.isMe)
        const others = participants.filter(participant => !participant.isMe)
        if (me.length !== 1 || others.length !== 1) return undefined
        const own = me[0]
        const peer = others[0]
        if (own === undefined || peer === undefined) return undefined
        return { ownParticipantId: own.participantId, peerNumber: peer.formattedNumber || peer.number }
      })
      .catch(() => undefined)
    cache.set(conversationId, pending)
  }
  return pending
}

/** Longest prefix (country code plus an optional trunk digit) Google may omit from a peer number. */
const MAX_OMITTED_PREFIX_DIGITS = 4

/**
 * Decide whether a Google-supplied peer number is the configured E.164 number.
 *
 * Digits-only equality, plus one asymmetric fallback: Google sometimes reports a
 * peer's national number without the country code, so the *peer* may be shorter
 * by at most a country code. A configured number that is shorter than the peer
 * never matches — otherwise a short entry would authorize every longer number
 * ending with it.
 */
export function numbersMatch(configured: string, peer: string): boolean {
  const digits = (value: string) => value.replace(/\D+/gu, '')
  const expected = digits(configured)
  const actual = digits(peer)
  if (expected === actual) return true
  const omitted = expected.length - actual.length
  return actual.length >= 8
    && omitted > 0
    && omitted <= MAX_OMITTED_PREFIX_DIGITS
    && expected.endsWith(actual)
}

/** Pure inbound policy shared by the production adapter and its tests. */
export function acceptsInboundMessage(
  message: { text: string; participantId: string },
  facts: ConversationFacts | undefined,
  authorizedNumbers: readonly string[],
): boolean {
  if (facts === undefined) return false
  if (isOwnMessage(message as InboundMessage, facts.ownParticipantId)) return false
  if (message.text.trim().length === 0) return false
  return authorizedNumbers.some(number => numbersMatch(number, facts.peerNumber))
}

/** Build a production Google Messages connection over the stored session. */
export const createGmessagesConnection: SmsConnectionFactory = async config => {
  const session = await config.loadSession()
  if (session === undefined) {
    throw new PluginError('session-missing', 'No Google Messages session is stored; pair before connecting.')
  }
  const queue = new AsyncQueue<SmsInboundMessage>()
  const stopSignal = new AbortController()
  const factsCache = new Map<string, Promise<ConversationFacts | undefined>>()
  const tracker = createMessageTracker({ maxIds: 1_024 })
  let operations: OperationDispatcher | undefined
  let death: SmsConnectionDeath | null = null

  const deliver = async (
    message: InboundMessage,
    ops: OperationDispatcher,
  ): Promise<void> => {
    const facts = await factsForConversation(ops, message.conversationId, factsCache)
    if (!acceptsInboundMessage(message, facts, config.authorizedNumbers)) return
    queue.push(await makeChannel(message, ops, facts as ConversationFacts))
  }

  const handleEvent = (event: ClientEvent): void => {
    if (event.kind !== 'push' || operations === undefined) return
    const pushCase = event.update.case
    if (pushCase === 'unpaired' || pushCase === 'accountChange') {
      // The relay says this pairing is gone; reconnecting with the same session cannot help.
      death = { permanent: true, reason: pushCase }
      config.onDiagnostic?.(`google messages push ${pushCase}: session is permanently dead`)
      stopSignal.abort()
      return
    }
    for (const message of messagesOf(event.update)) {
      if (tracker(message)?.type !== 'message') continue
      void deliver(message, operations)
    }
  }

  const client = await connect({
    endpoints: config.endpoints ?? GOOGLE_ENDPOINTS,
    apiKey: config.apiKey ?? GOOGLE_WEB_API_KEY,
    session,
    onSessionUpdate: async blob => {
      try {
        await config.onSessionUpdate(blob)
      } catch {
        // Rotation persistence failure is surfaced by the supervisor's reconnect loop.
      }
    },
    fetchImpl: config.fetchImpl ?? fetch,
    stopSignal: stopSignal.signal,
    ...(config.newId === undefined ? {} : { newId: config.newId }),
    onEvent: handleEvent,
    onRotation: event => config.onDiagnostic?.(describeRotation(event), event.kind === 'cycle' ? 'debug' : 'info'),
    onSessionError: error => config.onDiagnostic?.(`session persistence failed: ${errorName(error)}`),
  })
  operations = client.operations
  const finished: Promise<SmsConnectionDeath | null> = client.finished().then(reason => {
    queue.close()
    // A verdict recorded from an `unpaired`/`accountChange` push wins regardless of
    // how the run then ended. (gmessages 0.1.2: a `stopSignal` abort runs the real
    // teardown and settles `finished()` with null, same as `stop()`, so `reason`
    // is null here in practice; the precedence makes that irrelevant.)
    if (death !== null) return death
    if (reason === null) return null
    const described = describeDeath(reason)
    config.onDiagnostic?.(`google messages stream died: ${described.reason}`)
    return described
  })

  return {
    messages: queue,
    stop: async () => {
      stopSignal.abort()
      await client.stop()
      queue.close()
    },
    finished: () => finished,
  }
}

/** Classify a `connect()` failure that no reconnect can fix; undefined means transient. */
function permanentConnectFailure(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'JarDeadError') return 'jar-dead'
  if (code === 'session-missing' || code === 'session-dead') return String(code)
  return undefined
}

/** Reduce a gmessages death to a redacted reason; only a dead jar is permanent. */
function describeDeath(reason: DeathReason): SmsConnectionDeath {
  switch (reason.kind) {
    case 'jar-dead':
      return { permanent: true, reason: 'jar-dead' }
    case 'stream-fatal':
      return { permanent: false, reason: `stream-fatal:${reason.status}` }
    case 'stream-error':
      return { permanent: false, reason: `stream-error:${errorName(reason.error)}` }
    case 'refresh-failed':
      return { permanent: false, reason: `refresh-failed:${errorName(reason.error)}` }
  }
}

function describeRotation(event: RotationEvent): string {
  switch (event.kind) {
    case 'cycle':
      return `cookie rotation ${String((event.outcome as { kind?: unknown }).kind ?? 'unknown')}`
    case 'stalled':
      return `cookie rotation stalled (${event.reason}); the session is dying and will need a new pairing if it does not recover`
    case 'error':
      return `cookie rotation error ${errorName(event.error)}`
  }
}

/** Error class name only: never the message, which may quote cookies or URLs. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** Build the reply/typing channel for one accepted inbound message. */
async function makeChannel(
  message: InboundMessage,
  ops: OperationDispatcher,
  facts: ConversationFacts,
): Promise<SmsInboundMessage> {
  return {
    id: message.messageId,
    text: message.text,
    responding: async <T>(callback: () => Promise<T>): Promise<T> => {
      try {
        await setTyping(ops, { conversationId: message.conversationId, typing: true })
      } catch {
        // Typing is best-effort; a failed indicator must not block the DSH turn.
      }
      try {
        return await callback()
      } finally {
        try {
          await setTyping(ops, { conversationId: message.conversationId, typing: false })
        } catch {
          // Best-effort, same as above.
        }
      }
    },
    send: async (text: string): Promise<void> => {
      await sendMessage(ops, {
        conversationId: message.conversationId,
        text,
        participantId: facts.ownParticipantId,
      })
    },
  }
}
