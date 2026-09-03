import { describe, expect, it, vi } from 'vitest'
import {
  acceptsInboundMessage,
  AsyncQueue,
  numbersMatch,
  SmsSupervisor,
  type ConversationFacts,
  type SmsConnection,
  type SmsConnectionConfig,
  type SmsConnectionDeath,
} from '../src/gmessages-runtime.js'
import type { RuntimeView } from '../src/types.js'

const connectionConfig: SmsConnectionConfig = {
  loadSession: async () => 'session-blob',
  onSessionUpdate: async () => {},
  authorizedNumbers: ['+14155552671'],
}

const facts: ConversationFacts = {
  ownParticipantId: 'device-1',
  peerNumber: '+14155552671',
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'message-1',
    conversationId: 'conversation-1',
    participantId: 'peer-1',
    text: 'hello',
    timestampMicros: 1_700_000_000_000_000n,
    statusCode: 100,
    statusLabel: null,
    reactions: [],
    attachments: [],
    ...overrides,
  }
}

function heldConnection(stop = vi.fn(async () => {})): SmsConnection {
  return {
    messages: (async function* () {
      await new Promise<void>(() => {})
    })(),
    stop,
  }
}

/** A connection whose stream ends immediately with the given death verdict. */
function dyingConnection(death: SmsConnectionDeath | null): SmsConnection {
  return {
    messages: (async function* () {})(),
    stop: vi.fn(async () => {}),
    finished: async () => death,
  }
}

function collectStates() {
  const states: RuntimeView[] = []
  return { states, onState: (state: RuntimeView) => { states.push(state) } }
}

describe('Google Messages ingress policy', () => {
  it('accepts only authorized 1:1 text DMs from a resolvable roster', () => {
    expect(acceptsInboundMessage(inbound(), facts, connectionConfig.authorizedNumbers)).toBe(true)
    expect(acceptsInboundMessage(inbound({ text: '  ' }), facts, connectionConfig.authorizedNumbers)).toBe(false)
    expect(acceptsInboundMessage(inbound({ text: '' }), facts, connectionConfig.authorizedNumbers)).toBe(false)
    expect(acceptsInboundMessage(inbound(), undefined, connectionConfig.authorizedNumbers)).toBe(false)
  })

  it('rejects unknown peers, including suffix-adjacent numbers', () => {
    const other = { ...facts, peerNumber: '+14155559999' }
    expect(acceptsInboundMessage(inbound(), other, connectionConfig.authorizedNumbers)).toBe(false)
  })

  it('compares numbers tolerantly with a bounded suffix fallback', () => {
    expect(numbersMatch('+14155552671', '+14155552671')).toBe(true)
    expect(numbersMatch('+14155552671', '14155552671')).toBe(true)
    expect(numbersMatch('+8613800138000', '13800138000')).toBe(true)
    expect(numbersMatch('+14155552671', '+14155559999')).toBe(false)
    expect(numbersMatch('+86', '+8613800138000')).toBe(false)
  })

  it('never lets a shorter configured number authorize a longer peer', () => {
    // Only the peer may lack a country code; a configured suffix must not widen authorization.
    expect(numbersMatch('+12345678', '+8613912345678')).toBe(false)
    expect(numbersMatch('+13800138000', '+8613800138000')).toBe(false)
    // The omitted prefix is bounded to a country code plus a trunk digit.
    expect(numbersMatch('+14155552671', '4155552671')).toBe(true)
    expect(numbersMatch('+123456789012345', '55552671')).toBe(false)
  })
})

describe('SmsSupervisor', () => {
  it('serializes replacement and stops only the active connection', async () => {
    const firstStop = vi.fn(async () => {})
    const secondStop = vi.fn(async () => {})
    const factory = vi.fn()
      .mockResolvedValueOnce(heldConnection(firstStop))
      .mockResolvedValueOnce(heldConnection(secondStop))
    const states: string[] = []
    const supervisor = new SmsSupervisor(factory, {
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      onState: state => { states.push(state.phase) },
      onMessage: async () => {},
    })

    await supervisor.restart(connectionConfig)
    await supervisor.restart({ ...connectionConfig, authorizedNumbers: ['+442071838750'] })
    expect(firstStop).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenNthCalledWith(2, expect.objectContaining({ authorizedNumbers: ['+442071838750'] }))
    await supervisor.stop()
    expect(secondStop).toHaveBeenCalledOnce()
    expect(supervisor.state).toEqual({ phase: 'stopped' })
    expect(states).toContain('listening')
  })

  it('reconnects with bounded exponential backoff and jitter', async () => {
    vi.useFakeTimers()
    try {
      const factory = vi.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(heldConnection())
      const supervisor = new SmsSupervisor(factory, {
        reconnectMinMs: 100,
        reconnectMaxMs: 1_000,
        random: () => 0.5,
        now: () => Date.now(),
        onState: () => {},
        onMessage: async () => {},
      })
      await supervisor.restart(connectionConfig)
      expect(supervisor.state).toMatchObject({ phase: 'retrying', attempt: 1 })
      await vi.advanceTimersByTimeAsync(100)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(supervisor.state.phase).toBe('listening')
      await supervisor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops instead of retrying when no session is stored', async () => {
    const factory = vi.fn(async () => {
      throw new Error('session-missing')
    })
    const supervisor = new SmsSupervisor(factory, {
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      onState: () => {},
      onMessage: async () => {},
    })
    await supervisor.restart({
      ...connectionConfig,
      loadSession: async () => undefined,
    })
    expect(supervisor.state.phase).toBe('stopped')
    expect(factory).not.toHaveBeenCalled()
  })

  it('reconnects when the message stream ends unexpectedly', async () => {
    vi.useFakeTimers()
    try {
      const ended = (async function* () { return })()
      const factory = vi.fn()
        .mockResolvedValueOnce({ messages: ended, stop: async () => {} })
        .mockResolvedValueOnce(heldConnection())
      const supervisor = new SmsSupervisor(factory, {
        reconnectMinMs: 100,
        reconnectMaxMs: 1_000,
        random: () => 0.5,
        now: () => Date.now(),
        onState: () => {},
        onMessage: async () => {},
      })
      await supervisor.restart(connectionConfig)
      // The ended stream is observed during start; a reconnect is scheduled.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(supervisor.state.phase).toBe('listening')
      await supervisor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SmsSupervisor permanent death', () => {
  it('surfaces session-dead and stops retrying when the stream reports a dead jar', async () => {
    const { states, onState } = collectStates()
    const factory = vi.fn(async () => dyingConnection({ permanent: true, reason: 'jar-dead' }))
    const supervisor = new SmsSupervisor(factory, {
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      onState,
      onMessage: async () => {},
    })
    await supervisor.restart(connectionConfig)
    await vi.waitFor(() => { expect(supervisor.state.phase).toBe('failed') })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(supervisor.state).toMatchObject({ phase: 'failed', error: { code: 'session-dead' } })
    expect(states.some(state => state.phase === 'retrying')).toBe(false)
    // An explicit retry still re-opens the connection with the same desired config.
    await supervisor.retry()
    expect(factory).toHaveBeenCalledTimes(2)
    await supervisor.stop()
  })

  it('stops retrying when connect itself reports a dead jar', async () => {
    const { onState } = collectStates()
    const factory = vi.fn(async () => {
      throw Object.assign(new Error('relay refused the cookies'), { name: 'JarDeadError', code: 'JarDeadError' })
    })
    const supervisor = new SmsSupervisor(factory, {
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      onState,
      onMessage: async () => {},
    })
    await supervisor.restart(connectionConfig)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(supervisor.state).toMatchObject({ phase: 'failed', error: { code: 'session-dead' } })
    await supervisor.stop()
  })

  it('keeps reconnecting after a transient death', async () => {
    const { onState } = collectStates()
    const factory = vi.fn(async () => dyingConnection({ permanent: false, reason: 'stream-fatal:502' }))
    const supervisor = new SmsSupervisor(factory, {
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      onState,
      onMessage: async () => {},
      random: () => 0.5,
    })
    await supervisor.restart(connectionConfig)
    await vi.waitFor(() => { expect(factory.mock.calls.length).toBeGreaterThan(2) })
    await supervisor.stop()
  })
})

describe('AsyncQueue', () => {
  it('buffers until consumed and ends on close', async () => {
    const queue = new AsyncQueue<string>()
    queue.push('one')
    queue.push('two')
    const collected: string[] = []
    const reader = (async () => {
      for await (const value of queue) collected.push(value)
    })()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(collected).toEqual(['one', 'two'])
    queue.push('three')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(collected).toEqual(['one', 'two', 'three'])
    queue.close()
    await reader
    expect(collected).toEqual(['one', 'two', 'three'])
  })

  it('resolves a pending read immediately on close', async () => {
    const queue = new AsyncQueue<number>()
    let done = false
    void (async () => {
      for await (const value of queue) void value
      done = true
    })()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(done).toBe(false)
    queue.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(done).toBe(true)
  })
})
