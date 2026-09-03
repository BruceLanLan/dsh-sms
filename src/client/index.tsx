import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// These type-only imports merge the settings slot and generated Remote faces.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from 'dsh-sms/remote'
import { SmsSettingsController } from './controller.js'
import { inject, settingsInject } from './injections.js'
import {
  SmsSettingsSection,
  type SmsSettingsInjected,
} from './SmsSettingsSection.js'
import { installStyles } from './styles.js'

export { inject, settingsInject } from './injections.js'

export type {
  SmsClientSnapshot,
} from './controller.js'
export type {
  SmsSettingsInjected,
  SmsSettingsSectionProps,
} from './SmsSettingsSection.js'

/** Mount the generated RPC contribution and register Settings > SMS. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const settingsFiber = ctx.inject(settingsInject, (readyCtx) => {
    const controller = new SmsSettingsController(readyCtx.remote.dshSms)
    const removeStyles = installStyles()
    const injected = (): SmsSettingsInjected => ({ controller })

    readyCtx.slots.inject('settings.section', () => readyCtx.slots.register({
      name: 'settings.section',
      id: 'sms',
      order: 45,
      label: () => 'SMS',
      inject: injected,
    }, SmsSettingsSection))

    return () => {
      controller.dispose()
      removeStyles()
    }
  })

  try {
    await settingsFiber
  } catch (error) {
    await unmountRemote()
    throw error
  }

  return async () => {
    await settingsFiber.dispose()
    await unmountRemote()
  }
}

export default { inject, apply }
