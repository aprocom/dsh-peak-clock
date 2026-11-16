/**
 * Peak Clock — Host half.
 *
 * DeepSeek publishes two prices for the same model and switches between them on
 * a UTC clock that follows the Beijing calendar. The browser half can compute
 * that clock on its own; this half supplies the three things it cannot know:
 *
 * - the Chinese public-holiday calendar, bundled for the years we ship and
 *   fetched for later years when the bundle is silent;
 * - the price table, so the panel never renders a copy that can drift;
 * - the session's exact spend and the account balance, read from the Host
 *   services that own them.
 *
 * Both routes are read-only, same-origin, and carry no credentials to the
 * browser. Nothing is written to disk and nothing is logged.
 */

import { readFileSync } from 'node:fs'

import { beijingDayKey, isPeakInstant } from './lib/engine.js'
import {
  MODELS,
  OFF_PEAK_MULTIPLIER,
  PRICING_CURRENCY,
  PRICING_SOURCE,
  PRICING_UNIT_TOKENS,
  PRICING_UPDATED,
  costOfUsage,
  priceFor,
} from './lib/rules.js'

/** The bundled State Council calendar, transcribed into stable holiday keys. */
const BUNDLED = JSON.parse(readFileSync(new URL('./lib/holidays.json', import.meta.url), 'utf8'))

const HOLIDAYS_PATH = '/api/peak-clock/holidays'
const FINANCE_PATH = '/api/peak-clock/finance'

const APP_TITLE = 'peak-clock'

/** Chinese holiday names from the notices, mapped onto locale dictionary keys. */
const HOLIDAY_KEYS = {
  元旦: 'new-year',
  春节: 'spring-festival',
  清明节: 'qingming',
  劳动节: 'labour-day',
  端午节: 'dragon-boat',
  中秋节: 'mid-autumn',
  国庆节: 'national-day',
}

const YEAR_TTL_MS = 12 * 60 * 60 * 1000
const YEAR_FAILURE_TTL_MS = 15 * 60 * 1000
const YEAR_CACHE_LIMIT = 8
const BALANCE_TTL_MS = 60 * 1000
const BALANCE_FAILURE_TTL_MS = 15 * 1000
const UPSTREAM_TIMEOUT_MS = 7000

/** year -> { expires, value } */
const yearCache = new Map()
/** year -> Promise, so concurrent reads share one upstream chain */
const yearInflight = new Map()
/** sessionId -> { watermark, value } */
const spendCache = new Map()
/** sessionId -> Promise, so concurrent reads share one fold */
const spendInflight = new Map()
/** one balance snapshot for the whole Host, keyed by locale */
const balanceCache = { key: null, expires: 0, value: null }

/**
 * Host services this plugin needs. `webServer` owns both routes; every other
 * service is resolved softly so a Host without it degrades instead of failing.
 */
export const inject = ['webServer']

// ─── Calendar ───────────────────────────────────────────────────────────────

/**
 * The bundled calendar of one year.
 * @param {number} year - a four-digit year.
 * @returns {{ holidays: Record<string, string>, workdays: Record<string, string> } | null} the entries, or null when the year is not bundled.
 */
function bundledYear(year) {
  const entry = BUNDLED.years[String(year)]
  if (entry === undefined) return null
  return { holidays: entry.holidays || {}, workdays: entry.workdays || {} }
}

/**
 * Map a Chinese holiday name onto a stable dictionary key.
 * @param {string} name - the name as the notice writes it.
 * @returns {string} a key the locale dictionaries translate.
 */
function holidayKey(name) {
  return Object.prototype.hasOwnProperty.call(HOLIDAY_KEYS, name) ? HOLIDAY_KEYS[name] : 'holiday'
}

/**
 * Fetch one JSON document with a bounded timeout.
 * @param {string} url - the document address.
 * @returns {Promise<unknown>} the parsed body.
 */
async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': `${APP_TITLE}/1.0` },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`upstream ${response.status}`)
  return response.json()
}

/**
 * Normalize `holiday-cn`'s year document.
 * @param {unknown} payload - the parsed document.
 * @param {number} year - the requested year.
 * @returns {{ holidays: Record<string, string>, workdays: Record<string, string> } | null} the entries, or null when the document carries no usable days.
 */
function normalizeHolidayCn(payload, year) {
  const days = payload && Array.isArray(payload.days) ? payload.days : null
  if (days === null) return null
  const holidays = {}
  const workdays = {}
  for (const day of days) {
    if (!day || typeof day.date !== 'string' || !day.date.startsWith(`${year}-`)) continue
    const target = day.isOffDay ? holidays : workdays
    target[day.date] = holidayKey(typeof day.name === 'string' ? day.name : '')
  }
  return { holidays, workdays }
}

/**
 * Normalize `timor.tech`'s year document.
 * @param {unknown} payload - the parsed document.
 * @param {number} year - the requested year.
 * @returns {{ holidays: Record<string, string>, workdays: Record<string, string> } | null} the entries, or null when the document is not a calendar.
 */
function normalizeTimor(payload, year) {
  if (!payload || payload.code !== 0 || typeof payload.holiday !== 'object' || payload.holiday === null) return null
  const holidays = {}
  const workdays = {}
  for (const [monthDay, entry] of Object.entries(payload.holiday)) {
    if (!/^\d{2}-\d{2}$/.test(monthDay) || !entry) continue
    const key = `${year}-${monthDay}`
    const target = entry.holiday === true ? holidays : workdays
    target[key] = holidayKey(typeof entry.name === 'string' ? entry.name : '')
  }
  return { holidays, workdays }
}

/**
 * Fetch a year calendar from the public mirrors, first answer wins.
 * @param {number} year - a four-digit year.
 * @returns {Promise<{ holidays: Record<string, string>, workdays: Record<string, string>, source: string } | null>} the entries with their source, or null when every source failed.
 */
async function fetchYear(year) {
  const sources = [
    {
      name: 'holiday-cn',
      load: () => fetchJson(`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`).then((body) => normalizeHolidayCn(body, year)),
    },
    {
      name: 'holiday-cn (fastly)',
      load: () => fetchJson(`https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`).then((body) => normalizeHolidayCn(body, year)),
    },
    {
      name: 'timor.tech',
      load: () => fetchJson(`https://timor.tech/api/holiday/year/${year}`).then((body) => normalizeTimor(body, year)),
    },
  ]
  for (const source of sources) {
    try {
      const entries = await source.load()
      if (entries !== null && Object.keys(entries.holidays).length > 0) return { ...entries, source: source.name }
    } catch {
      // Try the next mirror; the panel shows a degraded calendar if all fail.
    }
  }
  return null
}

/**
 * The calendar of one year: bundled first, then the cached upstream chain.
 * @param {number} year - a four-digit year.
 * @returns {Promise<{ year: number, holidays: Record<string, string>, workdays: Record<string, string>, source: string, degraded: boolean }>} the calendar; an unavailable year answers with an empty holiday map and `degraded: true`.
 */
async function calendarFor(year) {
  const bundled = bundledYear(year)
  if (bundled !== null) {
    return { year, ...bundled, source: 'bundled', degraded: false }
  }
  const cached = yearCache.get(year)
  if (cached !== undefined && cached.expires > Date.now()) return cached.value
  if (yearInflight.has(year)) return yearInflight.get(year)
  const pending = (async () => {
    const fetched = await fetchYear(year)
    const value = fetched === null
      ? { year, holidays: {}, workdays: {}, source: 'none', degraded: true }
      : { year, holidays: fetched.holidays, workdays: fetched.workdays, source: fetched.source, degraded: false }
    yearCache.set(year, { expires: Date.now() + (fetched === null ? YEAR_FAILURE_TTL_MS : YEAR_TTL_MS), value })
    while (yearCache.size > YEAR_CACHE_LIMIT) yearCache.delete(yearCache.keys().next().value)
    return value
  })().finally(() => yearInflight.delete(year))
  yearInflight.set(year, pending)
  return pending
}

/**
 * Merge the calendars of several years into the shape the engine reads.
 * @param {Map<number, { holidays: Record<string, string>, workdays: Record<string, string>, degraded: boolean }>} calendars - per-year calendars.
 * @returns {{ holidays: Record<string, string>, workdays: Record<string, string>, degradedYears: number[] }} one merged calendar.
 */
function mergeCalendars(calendars) {
  const holidays = {}
  const workdays = {}
  const degradedYears = []
  for (const [year, calendar] of calendars) {
    Object.assign(holidays, calendar.holidays)
    Object.assign(workdays, calendar.workdays)
    if (calendar.degraded) degradedYears.push(year)
  }
  return { holidays, workdays, degradedYears }
}

// ─── Session spend ──────────────────────────────────────────────────────────

/**
 * Read the events of one session without replaying the whole log twice.
 *
 * The badge always describes the current, live session, so the live registry is
 * preferred: `snapshotEvents()` returns the log the Host already holds. A
 * session that is no longer live falls back to the query service, which replays
 * and validates the durable log.
 *
 * @param {object} ctx - the Host context.
 * @param {string} sessionId - the session to price.
 * @returns {Promise<{ events: readonly object[], watermark: string } | null>} the events and a cheap change marker, or null when the session is unknown.
 */
async function readSessionEvents(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const session = sessions !== null && sessions !== undefined && typeof sessions.get === 'function'
    ? sessions.get(sessionId)
    : undefined
  if (session !== null && session !== undefined && typeof session.snapshotEvents === 'function') {
    return { events: session.snapshotEvents(), watermark: `live:${session.seq}` }
  }
  if (session !== null && session !== undefined && typeof session.ownEvents === 'function') {
    return { events: session.ownEvents(), watermark: `live:${session.seq}` }
  }
  const query = ctx.get('sessionQuery')
  if (query === null || query === undefined || typeof query.readSession !== 'function') return null
  const record = await query.readSession(sessionId)
  const events = record && Array.isArray(record.events) ? record.events : []
  const last = events.length === 0 ? 0 : events[events.length - 1]
  return { events, watermark: `durable:${events.length}:${last && last.seq !== undefined ? last.seq : ''}` }
}

/**
 * Price every settled assistant message of a session at the window it settled in.
 * @param {readonly object[]} events - session events, oldest first.
 * @param {Map<number, { holidays: Record<string, string>, workdays: Record<string, string>, degraded: boolean }>} calendars - calendars for the years the events cover.
 * @returns {{ exact: boolean, requests: number, skipped: number, unknownModels: string[], total: number, tokens: object, byModel: object[] }} the estimate.
 */
function foldSpend(events, calendars) {
  const merged = mergeCalendars(calendars)
  const byModel = new Map()
  let total = 0
  let requests = 0
  let skipped = 0
  const unknownModels = new Set()
  let firstAt = null
  let lastAt = null
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    const usage = event.data && event.data.usage
    if (!usage) {
      skipped += 1
      continue
    }
    const time = typeof event.time === 'number' ? event.time : null
    if (time === null) {
      skipped += 1
      continue
    }
    const modelId = event.data.message && event.data.message.source ? event.data.message.source.model : undefined
    const price = priceFor(modelId, isPeakInstant(time, merged).peak ? 'peak' : 'off')
    if (price === null) {
      unknownModels.add(String(modelId === undefined ? 'unknown' : modelId))
      skipped += 1
      continue
    }
    const cost = costOfUsage(price, usage)
    const entry = byModel.get(price.modelId) || { model: price.modelId, requests: 0, cost: 0, tokens: { cacheHit: 0, cacheMiss: 0, output: 0 } }
    entry.requests += 1
    entry.cost += cost
    entry.tokens.cacheHit += Math.max(0, Number(usage.cacheReadTokens) || 0)
    entry.tokens.cacheMiss += Math.max(0, Number(usage.inputTokens) || 0) + Math.max(0, Number(usage.cacheWriteTokens) || 0)
    entry.tokens.output += Math.max(0, Number(usage.outputTokens) || 0)
    byModel.set(price.modelId, entry)
    total += cost
    requests += 1
    if (firstAt === null || time < firstAt) firstAt = time
    if (lastAt === null || time > lastAt) lastAt = time
  }
  const tokens = { cacheHit: 0, cacheMiss: 0, output: 0 }
  for (const entry of byModel.values()) {
    tokens.cacheHit += entry.tokens.cacheHit
    tokens.cacheMiss += entry.tokens.cacheMiss
    tokens.output += entry.tokens.output
  }
  return {
    exact: skipped === 0 && unknownModels.size === 0 && merged.degradedYears.length === 0,
    requests,
    skipped,
    unknownModels: [...unknownModels],
    total,
    tokens,
    byModel: [...byModel.values()],
    firstAt,
    lastAt,
    degradedYears: merged.degradedYears,
  }
}

/**
 * Build the spend section of the finance payload.
 * @param {object} ctx - the Host context.
 * @param {string | null} sessionId - the session to price.
 * @returns {Promise<object>} the spend section, labelled with why it is not exact.
 */
async function readSpend(ctx, sessionId) {
  if (sessionId === null) return { status: 'no-session' }
  const cached = spendCache.get(sessionId)
  let read
  try {
    read = await readSessionEvents(ctx, sessionId)
  } catch (error) {
    return { status: 'failed', reason: 'session-unreadable', message: String(error && error.message ? error.message : error).slice(0, 200) }
  }
  if (read === null) return { status: 'unavailable', reason: 'no-session-service' }
  if (cached !== undefined && cached.watermark === read.watermark) return cached.value

  const years = new Set()
  for (const event of read.events) {
    if (event !== null && typeof event === 'object' && event.type === 'assistant/message' && typeof event.time === 'number') {
      years.add(Number(beijingDayKey(event.time).slice(0, 4)))
    }
  }
  const calendars = new Map()
  for (const year of years) calendars.set(year, await calendarFor(year))
  const value = { status: 'ready', ...foldSpend(read.events, calendars), scope: 'session' }
  spendCache.set(sessionId, { watermark: read.watermark, value })
  while (spendCache.size > 200) spendCache.delete(spendCache.keys().next().value)
  return value
}

// ─── Balance ────────────────────────────────────────────────────────────────

/**
 * Read the Platform balance through the account service, cached for a minute.
 * @param {object} ctx - the Host context.
 * @param {string} locale - the active UI language.
 * @param {number} timezoneOffsetSeconds - the viewer's UTC offset.
 * @returns {Promise<object>} the balance section; failure never becomes a zero balance.
 */
async function readBalance(ctx, locale, timezoneOffsetSeconds) {
  if (balanceCache.value !== null && balanceCache.key === locale && balanceCache.expires > Date.now()) {
    return balanceCache.value
  }
  const account = ctx.get('deepseekAccount')
  if (account === null || account === undefined || typeof account.getBalance !== 'function') {
    return { status: 'unavailable' }
  }
  let value
  try {
    const raw = await account.getBalance({ version: '1.0.0', locale, timezoneOffsetSeconds })
    if (raw === null) value = { status: 'signed-out' }
    else if (raw.status === 'failed') value = { status: 'failed' }
    else {
      const wallets = Array.isArray(raw.value) ? raw.value : []
      const bonuses = Array.isArray(raw.bonusWallets) ? raw.bonusWallets : []
      const wallet = wallets.find((entry) => entry && entry.currency === 'CNY') || wallets[0] || bonuses[0] || null
      const bonus = bonuses.find((entry) => entry && entry.currency === (wallet ? wallet.currency : 'CNY')) || null
      value = wallet === null || wallet === undefined
        ? { status: 'ready', currency: null, amount: null, bonus: null }
        : {
            status: 'ready',
            currency: wallet.currency,
            amount: Number(wallet.balance),
            bonus: bonus === null ? null : Number(bonus.balance),
          }
    }
  } catch {
    value = { status: 'failed' }
  }
  balanceCache.value = value
  balanceCache.key = locale
  balanceCache.expires = Date.now() + (value.status === 'ready' ? BALANCE_TTL_MS : BALANCE_FAILURE_TTL_MS)
  return value
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

/**
 * Describe the price table so the panel renders the same numbers the estimate used.
 * @returns {object} the price table with derived off-peak rates.
 */
function priceTable() {
  return {
    currency: PRICING_CURRENCY,
    unitTokens: PRICING_UNIT_TOKENS,
    updated: PRICING_UPDATED,
    source: PRICING_SOURCE,
    offPeakMultiplier: OFF_PEAK_MULTIPLIER,
    models: MODELS.map((model) => ({
      id: model.id,
      peak: model.peak,
      off: {
        cacheHit: model.peak.cacheHit * OFF_PEAK_MULTIPLIER,
        cacheMiss: model.peak.cacheMiss * OFF_PEAK_MULTIPLIER,
        output: model.peak.output * OFF_PEAK_MULTIPLIER,
      },
    })),
  }
}

/**
 * Answer with JSON and the no-store headers every response carries.
 * @param {Request} request - the incoming Fetch request, used for `HEAD`.
 * @param {number} status - the HTTP status.
 * @param {object} body - the JSON payload.
 * @returns {Response} the response.
 */
function jsonResponse(request, status, body) {
  const text = JSON.stringify(body === undefined ? null : body)
  return new Response(request.method === 'HEAD' ? null : text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Whether a request comes from the page this Host serves.
 *
 * `Sec-Fetch-Site` is checked when the browser sends it, and an `Origin` must
 * name the same authority as the `Host` header, which is the only place the
 * requested authority survives. Both routes are read-only and carry no
 * credentials, so this is the CSRF surface worth closing, not authentication.
 *
 * @param {Request} request - the incoming request.
 * @returns {boolean} true when the request may be served.
 */
function sameOrigin(request) {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const authority = new URL(origin).host
    const host = request.headers.get('host')
    if (host !== null) return authority === host
    // The Host webserver keeps the client authority in the `host` header and
    // resolves the request URL against a placeholder origin, so the URL is a
    // fallback for a runtime that did not carry the header over.
    return authority === new URL(request.url).host
  } catch {
    return false
  }
}

/**
 * Answer a request that may read the JSON routes, or explain why it may not.
 * @param {Request} request - the incoming request.
 * @returns {Response | null} a refusal response, or null when the request is allowed.
 */
function refuse(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } })
  }
  if (!sameOrigin(request)) return jsonResponse(request, 403, { ok: false, error: 'cross-origin-forbidden' })
  return null
}

/**
 * The holiday route: one year of the Chinese calendar.
 * @param {Request} request - the incoming request.
 * @returns {Promise<Response>} the answer.
 */
async function handleHolidays(request) {
  const refusal = refuse(request)
  if (refusal !== null) return refusal
  const url = new URL(request.url)
  const raw = url.searchParams.get('year')
  const year = raw === null ? new Date().getUTCFullYear() : Number(raw)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return jsonResponse(request, 400, { ok: false, error: 'bad-year' })
  }
  const calendar = await calendarFor(year)
  return jsonResponse(request, 200, {
    ok: true,
    year,
    source: calendar.source,
    degraded: calendar.degraded,
    holidays: calendar.holidays,
    workdays: calendar.workdays,
  })
}

/**
 * The finance route: the price table, the balance and the session's spend.
 * @param {object} ctx - the Host context.
 * @param {Request} request - the incoming request.
 * @returns {Promise<Response>} the answer.
 */
async function handleFinance(ctx, request) {
  const refusal = refuse(request)
  if (refusal !== null) return refusal
  const url = new URL(request.url)
  const sessionId = (url.searchParams.get('sessionId') || '').slice(0, 200) || null
  const locale = (url.searchParams.get('locale') || 'en').slice(0, 20)
  const tz = Number(url.searchParams.get('tz'))
  const timezoneOffsetSeconds = Number.isFinite(tz) && Math.abs(tz) <= 86400 ? tz : 0

  const [balance, spend] = await Promise.all([
    readBalance(ctx, locale, timezoneOffsetSeconds),
    readSpend(ctx, sessionId),
  ])
  return jsonResponse(request, 200, {
    ok: true,
    fetchedAt: new Date().toISOString(),
    pricing: priceTable(),
    balance,
    spend,
  })
}

/**
 * Mount both routes and publish the price table revision once.
 * @param {object} ctx - the Host context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: HOLIDAYS_PATH, resource: (request) => handleHolidays(request) }),
    'peak-clock: holiday route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: FINANCE_PATH, resource: (request) => handleFinance(ctx, request) }),
    'peak-clock: finance route',
  )
}
