import { describe, expect, it, vi } from 'vitest'
import { SmsSettingsController } from '../src/client/controller.js'
import type { SmsPluginState, MutationResult } from '../src/types.js'

function state(phase: 'idle' | 'pairing'): SmsPluginState {
  return {
    revision: 1,
    settingsWritable: true,
    credentialConfigured: false,
    credentialWritable: true,
    pairing: phase === 'idle'
      ? { phase }
      : { phase, emoji: '🦄', numeric: '123' },
    runtime: { phase: 'stopped' },
  }
}

function success(value: SmsPluginState): { ok: true; value: MutationResult } {
  return { ok: true, value: { ok: true, state: value } }
}

describe('SMS settings controller concurrency', () => {
  it('does not let an older polling response overwrite a mutation result', async () => {
    let resolveRefresh!: (value: { ok: true; value: SmsPluginState }) => void
    const getState = vi.fn(() => new Promise<{ ok: true; value: SmsPluginState }>(resolve => {
      resolveRefresh = resolve
    }))
    const api = {
      getState,
      beginPairing: vi.fn(async () => success(state('pairing'))),
      cancelPairing: vi.fn(),
      saveNumbers: vi.fn(),
      disconnect: vi.fn(),
      retryRuntime: vi.fn(),
    }
    const controller = new SmsSettingsController(api as never)
    const unsubscribe = controller.subscribe(() => {})
    await expect(controller.beginPairing('cookies', 1)).resolves.toMatchObject({ ok: true })
    resolveRefresh({ ok: true, value: state('idle') })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().state?.pairing.phase).toBe('pairing')
    unsubscribe()
    controller.dispose()
  })

  it('allows only one browser mutation at a time', async () => {
    let resolve!: (value: ReturnType<typeof success>) => void
    const beginPairing = vi.fn(() => new Promise<ReturnType<typeof success>>(done => { resolve = done }))
    const api = {
      getState: vi.fn(async () => ({ ok: true as const, value: state('idle') })),
      beginPairing,
      cancelPairing: vi.fn(),
      saveNumbers: vi.fn(),
      disconnect: vi.fn(),
      retryRuntime: vi.fn(),
    }
    const controller = new SmsSettingsController(api as never)
    const first = controller.beginPairing('cookies', 1)
    await expect(controller.beginPairing('cookies', 1)).resolves.toBeUndefined()
    expect(beginPairing).toHaveBeenCalledOnce()
    resolve(success(state('pairing')))
    await expect(first).resolves.toMatchObject({ ok: true })
    controller.dispose()
  })
})
