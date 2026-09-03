// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SmsPluginState, MutationResult } from '../src/types.js'
import { SmsSettingsController } from '../src/client/controller.js'
import { SmsSettingsSection } from '../src/client/SmsSettingsSection.js'
import { inject, settingsInject } from '../src/client/injections.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function pluginState(overrides: Partial<SmsPluginState> = {}): SmsPluginState {
  return {
    revision: 7,
    settingsWritable: true,
    credentialConfigured: false,
    credentialWritable: true,
    pairing: { phase: 'idle' },
    runtime: { phase: 'stopped' },
    ...overrides,
  }
}

function success(state: SmsPluginState): { ok: true; value: MutationResult } {
  return { ok: true, value: { ok: true, state } }
}

function remote(initial: SmsPluginState) {
  return {
    getState: vi.fn(async () => ({ ok: true as const, value: initial })),
    beginPairing: vi.fn(async () => success(initial)),
    cancelPairing: vi.fn(async () => success(initial)),
    saveNumbers: vi.fn(async () => success(initial)),
    disconnect: vi.fn(async () => success(initial)),
    retryRuntime: vi.fn(async () => success(initial)),
  }
}

function renderState(initial: SmsPluginState) {
  const api = remote(initial)
  const controller = new SmsSettingsController(api as never)
  render(<SmsSettingsSection controller={controller} />)
  return { api, controller }
}

describe('Settings > SMS', () => {
  it('mounts the Remote contribution before waiting on its nested face', () => {
    expect(inject).toEqual(['remote'])
    expect(settingsInject).toEqual(['slots', 'remote.dshSms'])
  })

  it('pairs from pasted cookies and shows the verification code', async () => {
    const initial = pluginState()
    const pairing = pluginState({
      pairing: { phase: 'pairing', emoji: '🦄', numeric: '123' },
    })
    const { api } = renderState(initial)
    api.beginPairing.mockResolvedValue(success(pairing))
    const user = userEvent.setup()

    const textarea = await screen.findByLabelText('Google Messages cookies')
    await user.type(textarea, '# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tFALSE\t0\tSID\tsecret')
    await user.click(screen.getByRole('button', { name: 'Start pairing' }))
    await waitFor(() => {
      expect(api.beginPairing).toHaveBeenCalledWith({
        cookies: expect.stringContaining('Netscape'),
        expectedRevision: 7,
      })
    })
    expect(await screen.findByText(/🦄 123/)).toBeTruthy()
    expect(screen.getByText(/Approve the matching pairing prompt/)).toBeTruthy()
  })

  it('validates E.164 numbers and saves them', async () => {
    const initial = pluginState()
    const ready = pluginState({
      credentialConfigured: true,
      pairing: { phase: 'paired', pairedAt: Date.now() },
      authorizedNumbers: ['+14155552671'],
      runtime: { phase: 'listening', connectedAt: Date.now() },
    })
    const { api } = renderState(initial)
    api.saveNumbers.mockResolvedValue(success(ready))
    const user = userEvent.setup()
    const textarea = await screen.findByLabelText('Authorized peer numbers')

    await user.type(textarea, '415 555 2671')
    expect(screen.getByText(/full E\.164 number/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save numbers' }).hasAttribute('disabled')).toBe(true)
    await user.clear(textarea)
    await user.type(textarea, '+14155552671')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))

    await waitFor(() => {
      expect(api.saveNumbers).toHaveBeenCalledWith({ authorizedNumbers: ['+14155552671'], expectedRevision: 7 })
    })
    expect(await screen.findByText('Paired')).toBeTruthy()
    expect(screen.getAllByText('Listening')).toHaveLength(2)
  })

  it('surfaces optimistic settings conflicts', async () => {
    const initial = pluginState()
    const { api } = renderState(initial)
    api.saveNumbers.mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        error: { code: 'settings-conflict', message: 'Settings changed in another window. Refresh and try again.' },
        state: initial,
      },
    })
    const user = userEvent.setup()
    const textarea = await screen.findByLabelText('Authorized peer numbers')
    await user.type(textarea, '+14155552671')
    await user.click(screen.getByRole('button', { name: 'Save numbers' }))
    expect(await screen.findByText('Settings changed in another window. Refresh and try again.')).toBeTruthy()
  })

  it('retries a failed listener and disconnects after confirmation', async () => {
    const failed = pluginState({
      credentialConfigured: true,
      pairing: { phase: 'paired', pairedAt: Date.now() },
      authorizedNumbers: ['+14155552671'],
      runtime: {
        phase: 'failed',
        error: { code: 'runtime-failed', message: 'The listener could not connect.' },
      },
    })
    const listening = pluginState({
      ...failed,
      runtime: { phase: 'listening', connectedAt: Date.now() },
    })
    const disconnected = pluginState()
    const { api } = renderState(failed)
    api.retryRuntime.mockResolvedValue(success(listening))
    api.disconnect.mockResolvedValue(success(disconnected))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Retry listener' }))
    expect(api.retryRuntime).toHaveBeenCalledOnce()
    await screen.findAllByText('Listening')
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Google session will be removed'))
    expect(api.disconnect).toHaveBeenCalledWith({ expectedRevision: 7 })
    expect(await screen.findByText('Not paired')).toBeTruthy()
  })
})
