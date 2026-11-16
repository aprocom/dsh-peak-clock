/**
 * Peak Clock price table.
 *
 * The list prices DeepSeek publishes for its two models, in the currency of the
 * pricing page (USD per 1,000,000 tokens, peak hours), plus the helpers that map
 * a session's model id and provider route onto them. Off-peak prices are not
 * stored: the published rule is "half of the peak rate", so they are derived.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-16).
 */

/** The pricing page this table transcribes. */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'

/** ISO date the table was last checked against the pricing page. */
export const PRICING_UPDATED = '2026-11-16'

/** Currency and unit of every amount below. */
export const PRICING_CURRENCY = 'USD'
export const PRICING_UNIT_TOKENS = 1_000_000

/** Off-peak prices are half of the peak ones. */
export const OFF_PEAK_MULTIPLIER = 0.5

/** Provider ids DeepSeek bills on its own schedule. */
export const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account']

/**
 * Per-model list prices at the peak rate, USD per 1M tokens.
 * `cacheMiss` covers uncached input and cache writes (DeepSeek bills them at
 * the same rate); `cacheHit` is cached input.
 */
export const MODELS = [
  {
    id: 'deepseek-flash',
    aliases: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat'],
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  },
  {
    id: 'deepseek-v4-pro',
    aliases: ['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-reasoner'],
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
]

/**
 * Find the price entry for a session model id.
 * @param {string | null | undefined} modelId - the model id an assistant message reports.
 * @returns {{ id: string, aliases: string[], peak: { cacheHit: number, cacheMiss: number, output: number } } | null} the entry, or null for a model the table does not know.
 */
export function modelOf(modelId) {
  if (typeof modelId !== 'string' || modelId === '') return null
  const normalized = modelId.trim().toLowerCase()
  for (const model of MODELS) {
    if (model.aliases.includes(normalized)) return model
  }
  // Family match last, so an unknown future id in a known family is still
  // priced instead of disappearing from the estimate.
  if (/v4-pro|reasoner/.test(normalized)) return MODELS[1]
  if (/flash|deepseek-chat/.test(normalized)) return MODELS[0]
  return null
}

/**
 * Prices of one model in one pricing window.
 * @param {string | null | undefined} modelId - the model id an assistant message reports.
 * @param {'peak' | 'off'} phase - the window the request settled in.
 * @returns {{ modelId: string, cacheHit: number, cacheMiss: number, output: number } | null} USD per 1M tokens, or null for an unknown model.
 */
export function priceFor(modelId, phase) {
  const model = modelOf(modelId)
  if (model === null) return null
  const factor = phase === 'peak' ? 1 : OFF_PEAK_MULTIPLIER
  return {
    modelId: model.id,
    cacheHit: model.peak.cacheHit * factor,
    cacheMiss: model.peak.cacheMiss * factor,
    output: model.peak.output * factor,
  }
}

/**
 * Whether a provider id is billed on DeepSeek's own schedule.
 * @param {string | null | undefined} provider - a provider id from the model selection.
 * @returns {boolean} true for the DeepSeek direct routes (and unknown ids that name DeepSeek).
 */
export function isDeepSeekRoute(provider) {
  if (typeof provider !== 'string' || provider === '') return false
  return DEEPSEEK_PROVIDERS.includes(provider) || provider.startsWith('deepseek')
}

/**
 * Cost of one request, in the table's currency.
 * @param {{ cacheHit: number, cacheMiss: number, output: number }} price - per-1M-token prices.
 * @param {{ cacheReadTokens?: number, inputTokens?: number, cacheWriteTokens?: number, outputTokens?: number }} usage - provider-reported usage.
 * @returns {number} the cost; cache writes are billed at the miss rate.
 */
export function costOfUsage(price, usage) {
  const hit = Math.max(0, Number(usage.cacheReadTokens) || 0)
  const miss = Math.max(0, Number(usage.inputTokens) || 0)
  const write = Math.max(0, Number(usage.cacheWriteTokens) || 0)
  const output = Math.max(0, Number(usage.outputTokens) || 0)
  return (hit * price.cacheHit + (miss + write) * price.cacheMiss + output * price.output) / PRICING_UNIT_TOKENS
}
