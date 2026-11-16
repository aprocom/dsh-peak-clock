import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODELS,
  OFF_PEAK_MULTIPLIER,
  PRICING_CURRENCY,
  PRICING_SOURCE,
  PRICING_UNIT_TOKENS,
  PRICING_UPDATED,
  costOfUsage,
  isDeepSeekRoute,
  modelOf,
  priceFor,
} from '../lib/rules.js'

test('the table transcribes the published USD prices', () => {
  assert.equal(PRICING_CURRENCY, 'USD')
  assert.equal(PRICING_UNIT_TOKENS, 1_000_000)
  assert.equal(OFF_PEAK_MULTIPLIER, 0.5)
  assert.match(PRICING_SOURCE, /api-docs\.deepseek\.com\/quick_start\/pricing/)
  assert.match(PRICING_UPDATED, /^\d{4}-\d{2}-\d{2}$/)

  const flash = MODELS.find((model) => model.id === 'deepseek-flash')
  const pro = MODELS.find((model) => model.id === 'deepseek-v4-pro')
  assert.deepEqual(flash.peak, { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 })
  assert.deepEqual(pro.peak, { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 })
})

test('off-peak prices are exactly half the peak ones', () => {
  assert.deepEqual(priceFor('deepseek-flash', 'off'), {
    modelId: 'deepseek-flash',
    cacheHit: 0.003,
    cacheMiss: 0.15,
    output: 0.6,
  })
  assert.deepEqual(priceFor('deepseek-v4-pro', 'off'), {
    modelId: 'deepseek-v4-pro',
    cacheHit: 0.022,
    cacheMiss: 0.66,
    output: 1.98,
  })
  assert.deepEqual(priceFor('deepseek-v4-pro', 'peak'), {
    modelId: 'deepseek-v4-pro',
    cacheHit: 0.044,
    cacheMiss: 1.32,
    output: 3.96,
  })
})

test('legacy and family model ids resolve, unknown ids do not', () => {
  assert.equal(modelOf('deepseek-flash').id, 'deepseek-flash')
  assert.equal(modelOf('deepseek-v4-flash').id, 'deepseek-flash')
  assert.equal(modelOf('deepseek-chat').id, 'deepseek-flash')
  assert.equal(modelOf('DeepSeek-V4-Pro').id, 'deepseek-v4-pro')
  assert.equal(modelOf('deepseek-reasoner').id, 'deepseek-v4-pro')
  assert.equal(modelOf(''), null)
  assert.equal(modelOf(undefined), null)
  assert.equal(priceFor('some-other-model', 'peak'), null)
})

test('cost follows hit, miss and output rates per million tokens', () => {
  const peak = priceFor('deepseek-flash', 'peak')
  assert.equal(costOfUsage(peak, { inputTokens: 1_000_000 }), 0.3)
  assert.equal(costOfUsage(peak, { cacheReadTokens: 1_000_000 }), 0.006)
  assert.equal(costOfUsage(peak, { outputTokens: 1_000_000 }), 1.2)
  assert.equal(costOfUsage(peak, { cacheWriteTokens: 1_000_000 }), 0.3)

  const off = priceFor('deepseek-flash', 'off')
  assert.equal(costOfUsage(off, { outputTokens: 1_000_000 }), 0.6)
  const mixed = costOfUsage(off, { inputTokens: 500_000, cacheReadTokens: 1_000_000, outputTokens: 250_000 })
  assert.ok(Math.abs(mixed - (0.15 * 0.5 + 0.003 + 0.15)) < 1e-9, `mixed ${mixed}`)
  assert.equal(costOfUsage(peak, {}), 0)
  assert.equal(costOfUsage(peak, { inputTokens: -5 }), 0)
})

test('only the direct routes are billed on DeepSeek schedule', () => {
  assert.equal(isDeepSeekRoute('deepseek-account'), true)
  assert.equal(isDeepSeekRoute('deepseek-official'), true)
  assert.equal(isDeepSeekRoute('deepseek'), true)
  assert.equal(isDeepSeekRoute('openrouter'), false)
  assert.equal(isDeepSeekRoute('zai'), false)
  assert.equal(isDeepSeekRoute(null), false)
  assert.equal(isDeepSeekRoute(undefined), false)
  assert.equal(isDeepSeekRoute(''), false)
})
