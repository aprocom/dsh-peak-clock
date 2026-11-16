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

/**
 * Every element of a rendered tree, depth first.
 * @param {unknown} node - an element, an array, or a text node.
 * @param {object[]} [out] - the accumulator.
 * @returns {object[]} the elements.
 */
function elements(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (node.type === undefined) return out
  out.push(node)
  for (const child of node.children) elements(child, out)
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
  // The fold and the now label are drawn, not decorated with glyphs that may
  // fall back to tofu.
  assert.ok(css.includes('.dpc-details[open] > .dpc-summary::before'))
  assert.ok(css.includes('.dpc-now-label[data-edge="mid"]'))
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
  assert.equal(internals.durationText(t, 45 * 60_000), 'duration.ms:{"m":45,"s":0}')
  assert.equal(internals.durationText(t, 45 * 60_000 + 7_000), 'duration.ms:{"m":45,"s":7}')
  assert.equal(internals.durationText(t, 2 * 86400_000 + 15 * 3600_000), 'duration.dh:{"d":2,"h":15}')
  assert.equal(internals.durationText(t, 3 * 86400_000), 'duration.d:{"d":3}')
  assert.equal(internals.durationText(t, 30_000), 'duration.s:{"s":30}')
  assert.equal(internals.durationText(t, 0), 'duration.soon')
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
  assert.ok(content.includes('money.sessionIn'))
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
  // The balance is account-wide and stays; the prices and the spend do not.
  assert.ok(content.includes('money.title'))
  assert.equal(content.includes('money.sessionIn'), false)
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
  assert.ok(content.includes('money.title'))
  // No spend is attributed while the provider is unknown.
  assert.equal(content.includes('money.sessionIn'), false)
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

/**
 * A model-directory service for one provider.
 * @param {string | null} provider - the selected provider id.
 * @returns {object} the service face.
 */
function directoryService(provider) {
  return {
    directoryFor: () => ({
      store: {
        subscribe: () => () => {},
        getSnapshot: () => ({ current: provider === null ? null : { provider, model: 'deepseek-flash' } }),
      },
    }),
  }
}

test('the badge renders inside the composer row for a direct route', () => {
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru' }),
    },
    get: (name) => (name === 'modelDirectories' ? directoryService('deepseek-account') : null),
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
    get: (name) => (name === 'modelDirectories' ? directoryService('openrouter') : null),
  }
  const element = internals.PeakClockBadge({ ctx, sessionId: 'session-2', useProjection: () => undefined, t: identity })
  assert.equal(element.props['data-detached'], 'true')
  assert.ok(texts(element).includes('—'))
})

test('an undeclared model-directory service is read through ctx.get, never directly', () => {
  // Cordis throws on `ctx.modelDirectories` when the plugin did not declare it
  // in `inject`; this getter reproduces that failure the badge hit in the app.
  const ctx = {
    get: (name) => (name === 'modelDirectories' ? directoryService('deepseek-account') : null),
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru' }),
    },
  }
  Object.defineProperty(ctx, 'modelDirectories', {
    configurable: true,
    get() {
      throw new Error('cannot get property "modelDirectories" without inject')
    },
  })
  const element = internals.PeakClockBadge({ ctx, sessionId: 'session-3', useProjection: () => undefined, t: identity })
  assert.equal(element.type, 'div')
  assert.equal(element.props['data-detached'], 'false')
})

test('the timeline labels sit on the same axis as the bar', () => {
  const children = internals.Timeline(SNAPSHOT, 'ru-RU').children.flat(Infinity)
  const ticks = children.find((child) => child && child.props && child.props.key === 'ticks')
  assert.ok(ticks, 'the tick row exists')
  const labels = ticks.children.flat(Infinity)
  assert.deepEqual(labels.map((tick) => tick.props.style.left), ['0.00%', '25.00%', '50.00%', '75.00%', '100.00%'])
  assert.deepEqual(labels.map((tick) => tick.props['data-edge']), ['start', 'mid', 'mid', 'mid', 'end'])
  assert.equal(labels.at(-1).children[0], '24:00')
  // The bar and the labels share one origin: the last segment never ends past it.
  const track = elements(internals.Timeline(SNAPSHOT, 'ru-RU')).find((node) => node.props.key === 'track')
  for (const segment of elements(track)) {
    if (segment.props.className !== 'dpc-seg') continue
    const left = Number.parseFloat(segment.props.style.left)
    const width = Number.parseFloat(segment.props.style.width)
    assert.ok(left >= 0 && left + width <= 100.01, `${left}+${width}`)
  }
})

test('the timeline names the instant under its now marker', () => {
  const nodes = elements(internals.Timeline(SNAPSHOT, 'ru-RU'))
  const label = nodes.find((node) => node.props.key === 'now-label')
  const marker = nodes.find((node) => node.props.className === 'dpc-now')
  assert.ok(label && marker, 'both the label and the marker render')
  assert.equal(label.props.style.left, marker.props.style.left, 'the label tracks the marker')
  // 02:00 UTC is 05:00 in Moscow, five hours into the local day.
  assert.equal(texts(label).join(''), '05:00')
  assert.equal(label.props['data-edge'], 'mid')
})

test('the now label hugs the edge of the band at the start and the end of a day', () => {
  const snapshotAt = (iso) => engineState(Date.parse(iso), { calendar: internals.HOLIDAY_CALENDAR.years['2026'], zone: 'Europe/Moscow', locale: 'ru-RU' })
  const labelOf = (snapshot) => elements(internals.Timeline(snapshot, 'ru-RU')).find((node) => node.props.key === 'now-label')
  // 21:10 UTC is 00:10 in Moscow: minutes into the day, so the label leans right.
  assert.equal(labelOf(snapshotAt('2026-11-16T21:10:00Z')).props['data-edge'], 'start')
  // 20:55 UTC is 23:55 in Moscow, just before the day wraps.
  assert.equal(labelOf(snapshotAt('2026-11-17T20:55:00Z')).props['data-edge'], 'end')
  // Mid-day stays centred.
  assert.equal(labelOf(snapshotAt('2026-11-17T09:00:00Z')).props['data-edge'], 'mid')
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

test('the price table is folded away so the money stays above the fold', () => {
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
  const nodes = elements(panel)
  const details = nodes.find((node) => node.type === 'details' && node.props.key === 'prices')
  assert.ok(details, 'the price table is a details block')
  assert.equal(details.props.open, undefined, 'collapsed until asked for')
  const summary = elements(details).find((node) => node.type === 'summary')
  assert.equal(summary.props.key, 'title', 'its title is the toggle')
  assert.equal(summary.props.className.includes('dpc-summary'), true)
  // The balance and the spend are not folded: they render open every time.
  const money = nodes.find((node) => node.props.key === 'money')
  assert.equal(money.type, 'div')
  assert.ok(texts(money).includes('money.balance'))
})

test('the model and its provider stack instead of wrapping as one line', () => {
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
  const row = elements(panel).find((node) => node.props.key === 'model')
  const value = elements(row).find((node) => node.props.key === 'v')
  assert.equal(value.props.className.includes('dpc-model'), true)
  const name = elements(value).find((node) => node.props.className === 'dpc-model-name')
  const provider = elements(value).find((node) => node.props.className === 'dpc-model-provider')
  assert.equal(texts(name).join(''), 'deepseek-flash')
  assert.equal(texts(provider).join(''), 'deepseek-account')
  // The joined form is what wrapped mid-token in the composer.
  assert.equal(texts(panel).includes('deepseek-flash · deepseek-account'), false)
})

test('the badge counts seconds inside the last hour', () => {
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'ru' }),
    },
    get: (name) => (name === 'modelDirectories' ? directoryService('deepseek-account') : null),
  }
  const element = internals.PeakClockBadge({ ctx, sessionId: 'session-4', useProjection: () => undefined, t: identity })
  const time = elements(element).find((node) => node.props.className === 'dpc-time')
  assert.match(String(time.children[0]), /^(\d+д|\d+:\d{2})$/)
  const button = elements(element).find((node) => node.type === 'button')
  assert.match(String(button.props.title), /^badge\.(peak|off) · duration\./)
})
