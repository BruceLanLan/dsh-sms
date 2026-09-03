import { describe, expect, it, vi } from 'vitest'
import {
  acceptsInboundMessage,
  AsyncQueue,
  numbersMatch,
  SmsSupervisor,
  type ConversationFacts,
  type SmsConnection,
  type SmsConnectionConfig,
} from '../src/gmessages-runtime.js'

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
