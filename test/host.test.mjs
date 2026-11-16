import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject } from '../index.js'

const HOLIDAYS = '/api/peak-clock/holidays'
const FINANCE = '/api/peak-clock/finance'

/**
 * Mount the Host half on a fake context that records its routes.
 * @param {object} [services] - the services `ctx.get` answers.
 * @returns {object} the context, with the registered resources in `resources`.
 */
function makeCtx(services = {}) {
  const resources = new Map()
  const ctx = {
    webServer: {
      register({ path, resource }) {
        resources.set(path, resource)
        return () => resources.delete(path)
      },
    },
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : null
    },
    effect(run) {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    resources,
  }
  apply(ctx)
  return ctx
}

/**
 * A Fetch request against the fake Host.
 * @param {string} path - the route and query.
 * @param {RequestInit} [init] - request options.
 * @returns {Request} the request.
 */
function request(path, init) {
  return new Request(`http://127.0.0.1:5333${path}`, init)
}

/**
 * One assistant message event.
 * @param {string} iso - settlement time.
 * @param {number} seq - the log position.
 * @param {string} model - the model the message reports.
 * @param {object | undefined} usage - provider-reported token usage.
 * @returns {object} the event.
 */
function message(iso, seq, model, usage) {
  return {
    type: 'assistant/message',
    time: Date.parse(iso),
    seq,
    data: { message: { source: { model } }, usage },
  }
}

/**
 * A live session stub whose log the finance route reads.
 * @param {object[]} events - the session events.
 * @returns {object} the session.
 */
function liveSession(events) {
  return {
    seq: events.length,
    snapshotEvents: () => events,
  }
}

test('the Host half declares only the web server and mounts two exact routes', () => {
  assert.deepEqual(inject, ['webServer'])
  const ctx = makeCtx()
  assert.deepEqual([...ctx.resources.keys()].sort(), [FINANCE, HOLIDAYS])
})

test('a bundled year answers from the package', async () => {
  const ctx = makeCtx()
  const response = await ctx.resources.get(HOLIDAYS)(request(`${HOLIDAYS}?year=2026`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.year, 2026)
  assert.equal(body.source, 'bundled')
  assert.equal(body.degraded, false)
  assert.equal(body.holidays['2026-10-01'], 'national-day')
  assert.equal(body.holidays['2026-02-17'], 'spring-festival')
  assert.equal(body.workdays['2026-02-14'], 'spring-festival')
  assert.equal(body.holidays['2026-11-16'], undefined)
})

test('the 2027 notice is bundled as well', async () => {
  const ctx = makeCtx()
  const body = await (await ctx.resources.get(HOLIDAYS)(request(`${HOLIDAYS}?year=2027`))).json()
  assert.equal(body.source, 'bundled')
  assert.equal(Object.keys(body.holidays).length > 20, true)
  for (const key of Object.keys(body.holidays)) assert.match(key, /^2027-\d{2}-\d{2}$/)
})

test('an unusable year is rejected instead of guessed', async () => {
  const ctx = makeCtx()
  const response = await ctx.resources.get(HOLIDAYS)(request(`${HOLIDAYS}?year=1999`))
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'bad-year' })
})

test('both routes refuse cross-site callers and writes', async () => {
  const ctx = makeCtx()
  for (const path of [HOLIDAYS, FINANCE]) {
    const crossSite = await ctx.resources.get(path)(request(path, { headers: { 'sec-fetch-site': 'cross-site' } }))
    assert.equal(crossSite.status, 403, path)
    assert.deepEqual(await crossSite.json(), { ok: false, error: 'cross-origin-forbidden' })

    const wrongOrigin = await ctx.resources.get(path)(request(path, {
      headers: { origin: 'https://evil.example', host: '127.0.0.1:5333' },
    }))
    assert.equal(wrongOrigin.status, 403, path)

    const rightOrigin = await ctx.resources.get(path)(request(path, {
      headers: { origin: 'http://127.0.0.1:5333', host: '127.0.0.1:5333' },
    }))
    assert.equal(rightOrigin.status, 200, path)

    const write = await ctx.resources.get(path)(request(path, { method: 'POST' }))
    assert.equal(write.status, 405, path)
    assert.equal(write.headers.get('allow'), 'GET, HEAD')
  }
})

test('a same-origin read and a HEAD are allowed', async () => {
  const ctx = makeCtx()
  const sameOrigin = async (path) => ctx.resources.get(path)(request(path, { headers: { 'sec-fetch-site': 'same-origin' } }))
  assert.equal((await sameOrigin(HOLIDAYS)).status, 200)
  assert.equal((await sameOrigin(FINANCE)).status, 200)

  const head = await ctx.resources.get(HOLIDAYS)(request(`${HOLIDAYS}?year=2026`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

test('an unbundled year degrades to the weekday rule and says so', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const ctx = makeCtx()
    const body = await (await ctx.resources.get(HOLIDAYS)(request(`${HOLIDAYS}?year=2031`))).json()
    assert.equal(body.ok, true)
    assert.equal(body.year, 2031)
    assert.equal(body.source, 'none')
    assert.equal(body.degraded, true)
    assert.deepEqual(body.holidays, {})
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the finance route prices each message in the window it settled in', async () => {
  const events = [
    message('2026-11-16T02:00:00Z', 1, 'deepseek-flash', { inputTokens: 1_000_000 }),
    message('2026-11-16T12:00:00Z', 2, 'deepseek-flash', { outputTokens: 1_000_000 }),
    message('2026-11-16T02:00:00Z', 3, 'deepseek-flash', undefined),
    message('2026-11-16T05:00:00Z', 4, 'some-unknown-model', { inputTokens: 10 }),
  ]
  const ctx = makeCtx({
    sessions: { get: (sessionId) => (sessionId === 'session-spend' ? liveSession(events) : undefined) },
  })
  const body = await (await ctx.resources.get(FINANCE)(request(`${FINANCE}?sessionId=session-spend&locale=spend`))).json()
  assert.equal(body.ok, true)
  assert.equal(body.pricing.currency, 'USD')
  assert.equal(body.pricing.models.length, 2)
  assert.equal(body.pricing.offPeakMultiplier, 0.5)
  assert.equal(body.balance.status, 'unavailable')
  assert.equal(body.spend.status, 'ready')
  assert.equal(body.spend.requests, 2)
  assert.equal(body.spend.skipped, 2)
  assert.deepEqual(body.spend.unknownModels, ['some-unknown-model'])
  assert.equal(body.spend.exact, false)
  assert.ok(Math.abs(body.spend.total - 0.9) < 1e-9, `total ${body.spend.total}`)
  assert.equal(body.spend.byModel.length, 1)
  assert.equal(body.spend.byModel[0].model, 'deepseek-flash')
  assert.equal(body.spend.byModel[0].tokens.cacheMiss, 1_000_000)
  assert.equal(body.spend.byModel[0].tokens.output, 1_000_000)
})

test('a fully priced session is exact and an absent session is labelled', async () => {
  const exactEvents = [
    message('2026-11-16T05:00:00Z', 1, 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ]
  const ctx = makeCtx({
    sessions: { get: (sessionId) => (sessionId === 'session-exact' ? liveSession(exactEvents) : undefined) },
  })
  const exact = await (await ctx.resources.get(FINANCE)(request(`${FINANCE}?sessionId=session-exact&locale=exact`))).json()
  assert.equal(exact.spend.exact, true)
  assert.equal(exact.spend.skipped, 0)
  // 05:00 UTC is off-peak: input 1.32/2 and output 3.96/2.
  assert.ok(Math.abs(exact.spend.total - 2.64) < 1e-9, `total ${exact.spend.total}`)

  const none = await (await ctx.resources.get(FINANCE)(request(`${FINANCE}?locale=none`))).json()
  assert.deepEqual(none.spend, { status: 'no-session' })
})

test('the balance is normalized from the account service', async () => {
  const ctx = makeCtx({
    deepseekAccount: {
      getBalance: async (client) => {
        assert.equal(typeof client.version, 'string')
        assert.ok(Number.isFinite(client.timezoneOffsetSeconds))
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '12.34' }],
          bonusWallets: [{ currency: 'CNY', balance: '1.5' }],
        }
      },
    },
  })
  const body = await (await ctx.resources.get(FINANCE)(request(`${FINANCE}?locale=balance-ready`))).json()
  assert.deepEqual(body.balance, { status: 'ready', currency: 'CNY', amount: 12.34, bonus: 1.5 })
})

test('a signed-out and a failing account are distinct outcomes', async () => {
  const signedOut = makeCtx({ deepseekAccount: { getBalance: async () => null } })
  const first = await (await signedOut.resources.get(FINANCE)(request(`${FINANCE}?locale=balance-out`))).json()
  assert.equal(first.balance.status, 'signed-out')

  const failing = makeCtx({ deepseekAccount: { getBalance: async () => { throw new Error('boom') } } })
  const second = await (await failing.resources.get(FINANCE)(request(`${FINANCE}?locale=balance-fail`))).json()
  assert.equal(second.balance.status, 'failed')
})
