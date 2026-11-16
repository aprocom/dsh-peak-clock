import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { MODELS as RULE_MODELS, PRICING_UPDATED as RULES_UPDATED } from '../lib/rules.js'
import { state as engineState } from '../lib/engine.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const SOURCE = read('client.js')

/**
 * Load the browser bundle the way the Web client module loader does.
 * @param {object} [react] - a React stand-in.
 * @returns {object} the module exports.
 */
let loadedWindow = null

function loadPlugin(react = hookStub()) {
  let captured = null
  const fakeWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    visualViewport: null,
    __ModuleLoader__: { load(spec) { captured = spec } },
  }
  loadedWindow = fakeWindow
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(fakeWindow)
  assert.ok(captured !== null, 'the module registers itself with the loader')
  assert.equal(captured.id, 'dsh-peak-clock')

  return captured.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected browser module: ${specifier}`)
  })
}

/**
 * A one-pass React stand-in: enough to execute one render without a reconciler.
 * @returns {object} the stub.
 */
function hookStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (compute) => compute(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useId: () => 'test-id',
  }
}

/**
 * Collect every text node of a rendered element tree.
 * @param {unknown} node - an element, an array, or a text node.
 * @param {string[]} [out] - the accumulator.
 * @returns {string[]} the texts.
 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) texts(child, out)
  }
  return out
}

const plugin = loadPlugin()
const internals = plugin.__internals

/**
 * The generated region of `client.js`.
 * @param {string} name - rules, engine or holidays.
 * @returns {string} the de-indented body.
 */
function region(name) {
  const source = read('client.js')
  const begin = `    // #region generated:${name}\n`
  const end = `\n    // #endregion generated:${name}`
  const start = source.indexOf(begin)
  const stop = source.indexOf(end)
  assert.ok(start >= 0 && stop > start, `region ${name} exists`)
  return source
    .slice(start + begin.length, stop)
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n')
}

test('the bundle exposes the Host contract', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(plugin.NS, 'plugin.peakClock')
})

test('the generated copies match their canonical files', () => {
  assert.equal(region('engine'), read('lib/engine.js').replace(/^export /gm, '').trimEnd())
  assert.equal(region('rules'), read('lib/rules.js').replace(/^export /gm, '').trimEnd())
  assert.equal(region('holidays'), `const HOLIDAY_CALENDAR = ${read('lib/holidays.json').trimEnd()}`)
})

test('every dictionary carries the same keys', () => {
  const { en, ru, zh } = internals.dictionaries
  const keys = Object.keys(en).sort()
  assert.deepEqual(Object.keys(ru).sort(), keys)
  assert.deepEqual(Object.keys(zh).sort(), keys)
  assert.ok(keys.length > 50)
  for (const key of keys) {
    assert.notEqual(en[key], '', `en.${key}`)
    assert.notEqual(ru[key], '', `ru.${key}`)
    assert.notEqual(zh[key], '', `zh.${key}`)
  }
})

test('the calendar snapshot is referentially stable per year', () => {
  const first = internals.snapshotYear(2026)
  const second = internals.snapshotYear(2026)
  assert.equal(first, second)
  assert.equal(first.source, 'bundled')
  assert.equal(first.holidays['2026-10-01'], 'national-day')
  assert.equal(internals.snapshotYear(2027), internals.snapshotYear(2027))
  assert.equal(internals.snapshotYear(2034), internals.EMPTY_CALENDAR)
})

test('the bundle prices with the canonical table', () => {
  assert.deepEqual(internals.MODELS, RULE_MODELS)
  assert.equal(internals.PRICING_UPDATED, RULES_UPDATED)
  assert.equal(internals.PRICING_CURRENCY, 'USD')
})

test('the styles use theme tokens, never literal colors', () => {
  const css = internals.CSS
  assert.ok(css.includes('var(--dsw-alias-'))
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no hex colors')
  assert.equal(/\brgba?\(/.test(css), false, 'no rgb() colors')
  assert.equal(/\bhsla?\(/.test(css), false, 'no hsl() colors')
  assert.equal(/font-family:\s*['"]/.test(css), false, 'no font family literals')
})

test('money formatting keeps the currency symbol and the digits asked for', () => {
  assert.equal(internals.formatMoney(0.0042, 'USD', 4), '$0.0042')
  assert.equal(internals.formatMoney(12.34, 'CNY', 2), '¥12.34')
  assert.equal(internals.formatMoney(3, 'EUR', 2), '3.00 EUR')
  assert.equal(internals.formatMoney(Number.NaN, 'USD', 2), '—')
  assert.equal(internals.formatMoney(undefined, null, 2), '—')
})

test('durations go through the dictionaries', () => {
  const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
  assert.equal(internals.durationText(t, 2 * 3600_000 + 18 * 60_000), 'duration.hm:{"h":2,"m":18}')
  assert.equal(internals.durationText(t, 45 * 60_000), 'duration.m:{"m":45}')
  assert.equal(internals.durationText(t, 30_000), 'duration.soon')
})

const SNAPSHOT = engineState(Date.parse('2026-11-16T02:00:00Z'), {
  calendar: internals.HOLIDAY_CALENDAR.years['2026'],
  zone: 'Europe/Moscow',
  locale: 'ru-RU',
})

const identity = (key) => key

test('a direct DeepSeek route shows the schedule, the prices and the money', () => {
  const panel = internals.Panel({
    id: 'panel',
    snapshot: SNAPSHOT,
    t: identity,
    locale: 'ru-RU',
    selection: { provider: 'deepseek-account', model: 'deepseek-flash' },
    finance: null,
    financeStatus: 'idle',
    holidayDegraded: false,
    onRefresh: () => {},
    onClose: () => {},
    bindOutside: () => {},
    style: {},
  })
  const content = texts(panel)
  assert.ok(content.includes('prices.title'))
  assert.ok(content.includes('money.title'))
  assert.ok(content.includes('money.balance'))
  assert.equal(content.includes('model.notDirect'), false)
  assert.ok(content.includes('badge.peak'))
  assert.ok(content.includes('rows.peakHours'))
})

test('another provider gets an explanation instead of a DeepSeek claim', () => {
  const panel = internals.Panel({
    id: 'panel',
    snapshot: SNAPSHOT,
    t: identity,
    locale: 'ru-RU',
    selection: { provider: 'openrouter', model: 'deepseek-flash' },
    finance: null,
    financeStatus: 'idle',
    holidayDegraded: false,
    onRefresh: () => {},
    onClose: () => {},
    bindOutside: () => {},
    style: {},
  })
  const content = texts(panel)
  assert.ok(content.includes('model.notDirect'))
  assert.equal(content.includes('money.title'), false)
  assert.equal(content.includes('prices.title'), false)
})

test('an unknown provider shows the table but attributes no spend', () => {
  const panel = internals.Panel({
    id: 'panel',
    snapshot: SNAPSHOT,
    t: identity,
    locale: 'ru-RU',
    selection: { provider: null, model: null },
    finance: null,
    financeStatus: 'idle',
    holidayDegraded: true,
    onRefresh: () => {},
    onClose: () => {},
    bindOutside: () => {},
    style: {},
  })
  const content = texts(panel)
  assert.ok(content.includes('model.unknownProvider'))
  assert.ok(content.includes('warn.holiday'))
  assert.ok(content.includes('prices.title'))
  assert.equal(content.includes('money.title'), false)
})

test('a ready finance payload renders the balance and the spend', () => {
  const panel = internals.Panel({
    id: 'panel',
    snapshot: SNAPSHOT,
    t: identity,
    locale: 'ru-RU',
    selection: { provider: 'deepseek-account', model: 'deepseek-flash' },
    finance: {
      ok: true,
      pricing: { currency: 'USD', updated: '2026-11-16', source: 'https://example.test/pricing', models: RULE_MODELS.map((model) => ({ id: model.id, peak: model.peak, off: model.peak })) },
      balance: { status: 'ready', currency: 'CNY', amount: 12.34, bonus: 1.5 },
      spend: { status: 'ready', exact: true, requests: 3, skipped: 0, unknownModels: [], total: 0.0042, byModel: [] },
    },
    financeStatus: 'ready',
    holidayDegraded: false,
    onRefresh: () => {},
    onClose: () => {},
    bindOutside: () => {},
    style: {},
  })
  const content = texts(panel)
  assert.ok(content.some((text) => text.includes('¥12.34')), JSON.stringify(content))
  assert.ok(content.some((text) => text.includes('$0.0042')), JSON.stringify(content))
  assert.ok(content.some((text) => text.includes('money.requests')))
})

test('the badge renders inside the composer row for a direct route', () => {
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru' }),
    },
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => ({ current: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
        },
      }),
    },
  }
  const Badge = internals.PeakClockBadge
  const element = Badge({ ctx, sessionId: 'session-1', useProjection: () => undefined, t: identity })
  assert.equal(element.type, 'div')
  assert.equal(element.props.className, 'dpc-root')
  assert.ok(['peak', 'off'].includes(element.props['data-phase']))
  assert.equal(element.props['data-detached'], 'false')
  const button = element.children.flat(Infinity).find((child) => child && child.type === 'button')
  assert.ok(button, 'renders the badge button')
  assert.equal(button.props['aria-expanded'], 'false')
  const content = texts(element)
  assert.ok(content.some((text) => text.startsWith('badge.')) || content.includes('—'))
})

test('the badge marks a third-party route instead of claiming a DeepSeek window', () => {
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru' }),
    },
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => ({ current: { provider: 'openrouter', model: 'deepseek-flash' } }),
        },
      }),
    },
  }
  const element = internals.PeakClockBadge({ ctx, sessionId: 'session-2', useProjection: () => undefined, t: identity })
  assert.equal(element.props['data-detached'], 'true')
  assert.ok(texts(element).includes('—'))
})

test('placePanel keeps the card inside the viewport', () => {
  const anchor = { getBoundingClientRect: () => ({ left: 1100, right: 1180, top: 700, bottom: 724 }) }
  const placed = internals.placePanel(anchor, 340)
  assert.ok(placed.left >= 8 && placed.left + 340 <= loadedWindow.innerWidth, `left ${placed.left}`)
  assert.ok(placed.top >= 8 && placed.top <= loadedWindow.innerHeight, `top ${placed.top}`)

  // A badge in the middle of the screen opens the card below itself.
  const middle = internals.placePanel({ getBoundingClientRect: () => ({ left: 500, right: 580, top: 200, bottom: 224 }) }, 340)
  assert.equal(middle.top, 230)
})
