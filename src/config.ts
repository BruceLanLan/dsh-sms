import s from '@deepseek-ai/schemastery'

/** Host-only operational configuration. */
export interface Config {
  /** Human-interaction timeout in milliseconds. */
  interactionTimeoutMs?: number
  /** Maximum Unicode-safe outbound SMS chunk length. */
  maxOutboundChars?: number
  /** Number of DSH sessions shown per `/sessions` page. */
  sessionsPerPage?: number
  /** Maximum durable inbound message ids retained. */
  dedupeEntries?: number
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs?: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs?: number
}

/** Fully resolved host-only operational configuration. */
export interface ResolvedConfig {
  /** Human-interaction timeout in milliseconds. */
  interactionTimeoutMs: number
  /** Maximum Unicode-safe outbound SMS chunk length. */
  maxOutboundChars: number
  /** Number of DSH sessions shown per `/sessions` page. */
  sessionsPerPage: number
  /** Maximum durable inbound message ids retained. */
  dedupeEntries: number
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs: number
}

/** Cordis plugin config schema. */
export const Config: s<Config> = s.object({
  interactionTimeoutMs: s.number().step(1).min(1_000).default(600_000),
  maxOutboundChars: s.number().step(1).min(256).default(3_500),
  sessionsPerPage: s.number().step(1).min(1).max(20).default(5),
  dedupeEntries: s.number().step(1).min(64).max(8_192).default(1_024),
  reconnectMinMs: s.number().step(1).min(100).default(1_000),
  reconnectMaxMs: s.number().step(1).min(1_000).default(60_000),
})

/** Resolve and cross-validate host-only config. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const reconnectMinMs = config.reconnectMinMs ?? 1_000
  const reconnectMaxMs = config.reconnectMaxMs ?? 60_000
  if (reconnectMaxMs < reconnectMinMs) {
    throw new Error('reconnectMaxMs must be greater than or equal to reconnectMinMs')
  }
  return {
    interactionTimeoutMs: config.interactionTimeoutMs ?? 600_000,
    maxOutboundChars: config.maxOutboundChars ?? 3_500,
    sessionsPerPage: config.sessionsPerPage ?? 5,
    dedupeEntries: config.dedupeEntries ?? 1_024,
    reconnectMinMs,
    reconnectMaxMs,
  }
}

/** Non-secret user settings stored by DSH. */
export interface PluginSettings {
  /** Authorized E.164 peer numbers whose DMs become DSH prompts. */
  authorizedNumbers?: string[]
}

/** DSH settings schema for non-secret user configuration. */
export const PluginSettingsSchema: s<PluginSettings> = s.object({
  authorizedNumbers: s.array(s.string()),
})
