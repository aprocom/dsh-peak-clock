window.__ModuleLoader__.load({
  id: 'dsh-peak-clock',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The detail panel is portalled to <body> because the docked composer is a
    // containing block: a fixed overlay inside it would be clipped or offset.
    // `react-dom` is part of the shared module table; an older shell without it
    // falls back to rendering the panel in place.
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    const NS = 'plugin.peakClock'
    const HOLIDAYS_ROUTE = '/api/peak-clock/holidays'
    const FINANCE_ROUTE = '/api/peak-clock/finance'
    const FINANCE_TTL_MS = 60 * 1000
    const REQUEST_TIMEOUT_MS = 15 * 1000

    // #region generated:rules
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
    const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'

    /** ISO date the table was last checked against the pricing page. */
    const PRICING_UPDATED = '2026-11-16'

    /** Currency and unit of every amount below. */
    const PRICING_CURRENCY = 'USD'
    const PRICING_UNIT_TOKENS = 1_000_000

    /** Off-peak prices are half of the peak ones. */
    const OFF_PEAK_MULTIPLIER = 0.5

    /** Provider ids DeepSeek bills on its own schedule. */
    const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account']

    /**
     * Per-model list prices at the peak rate, USD per 1M tokens.
     * `cacheMiss` covers uncached input and cache writes (DeepSeek bills them at
     * the same rate); `cacheHit` is cached input.
     */
    const MODELS = [
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
    function modelOf(modelId) {
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
    function priceFor(modelId, phase) {
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
    function isDeepSeekRoute(provider) {
      if (typeof provider !== 'string' || provider === '') return false
      return DEEPSEEK_PROVIDERS.includes(provider) || provider.startsWith('deepseek')
    }

    /**
     * Cost of one request, in the table's currency.
     * @param {{ cacheHit: number, cacheMiss: number, output: number }} price - per-1M-token prices.
     * @param {{ cacheReadTokens?: number, inputTokens?: number, cacheWriteTokens?: number, outputTokens?: number }} usage - provider-reported usage.
     * @returns {number} the cost; cache writes are billed at the miss rate.
     */
    function costOfUsage(price, usage) {
      const hit = Math.max(0, Number(usage.cacheReadTokens) || 0)
      const miss = Math.max(0, Number(usage.inputTokens) || 0)
      const write = Math.max(0, Number(usage.cacheWriteTokens) || 0)
      const output = Math.max(0, Number(usage.outputTokens) || 0)
      return (hit * price.cacheHit + (miss + write) * price.cacheMiss + output * price.output) / PRICING_UNIT_TOKENS
    }
    // #endregion generated:rules

    // #region generated:engine
    /**
     * Peak Clock engine.
     *
     * The pure pricing-clock rules: peak windows in UTC minutes, the Beijing
     * calendar that decides which days have a peak at all, the countdown around
     * the current window, and the local-day timeline. No imports and no I/O, so
     * the Host half, the browser bundle and the tests can all use it.
     *
     * The browser bundle embeds this file verbatim (imports and `export` keywords
     * aside); `test/engine-sync.test.mjs` compares the two, so the badge and the
     * Host can never disagree about when peak starts.
     */

    /** DeepSeek peak windows are published as 01:00-04:00 and 06:00-10:00 UTC. */
    const PEAK_WINDOWS_UTC = [
      [60, 240],
      [360, 600],
    ]

    /** Beijing is UTC+8 with no daylight saving time. */
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

    const MINUTE_MS = 60 * 1000
    const DAY_MS = 24 * 60 * 60 * 1000

    /** The timezone the pricing policy itself is written in. */
    const POLICY_ZONE = 'Asia/Shanghai'

    /** Sampling step of the local-day timeline. */
    const TIMELINE_STEP_MS = 5 * MINUTE_MS

    /** Intl formatters are expensive to build and immutable, so one per key is kept. */
    const formatterCache = new Map()

    /**
     * One cached `Intl.DateTimeFormat` per key.
     * @param {string} key - the cache key naming the options and the locale.
     * @param {() => Intl.DateTimeFormat} build - constructs the formatter.
     * @returns {Intl.DateTimeFormat} the formatter.
     */
    function formatterFor(key, build) {
      let found = formatterCache.get(key)
      if (found === undefined) {
        if (formatterCache.size > 32) formatterCache.clear()
        found = build()
        formatterCache.set(key, found)
      }
      return found
    }

    /** @param {number} value - any number. @returns {string} two digits. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** @param {number} value - any number. @param {number} min - lower bound. @param {number} max - upper bound. @returns {number} the clamped value. */
    function clamp(value, min, max) {
      return value < min ? min : value > max ? max : value
    }

    /**
     * Wall-clock parts of one instant in Beijing.
     * @param {number} ms - epoch milliseconds.
     * @returns {{ year: number, month: number, day: number, weekday: number, minuteOfDay: number }} Beijing calendar parts; `weekday` is 0 for Sunday.
     */
    function beijingParts(ms) {
      const date = new Date(ms + BEIJING_OFFSET_MS)
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
        minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
      }
    }

    /**
     * The Beijing calendar date of an instant, as `YYYY-MM-DD`.
     * @param {number} ms - epoch milliseconds.
     * @returns {string} the Beijing date key.
     */
    function beijingDayKey(ms) {
      const parts = beijingParts(ms)
      return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
    }

    /**
     * Minute of the UTC day.
     * @param {number} ms - epoch milliseconds.
     * @returns {number} 0..1439.
     */
    function utcMinuteOfDay(ms) {
      return Math.floor((((ms % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS)
    }

    /**
     * The instant of UTC midnight for a `YYYY-MM-DD` key. A published window
     * belongs to the UTC date that carries the same calendar number as the Beijing
     * policy date, and both windows lie between 00:00 and 16:00 UTC.
     * @param {string} dayKey - a date key.
     * @returns {number} epoch milliseconds of 00:00 UTC on that date.
     */
    function utcMidnightMs(dayKey) {
      const [year, month, day] = dayKey.split('-').map(Number)
      return Date.UTC(year, month - 1, day)
    }

    /**
     * The instant of Beijing midnight for a `YYYY-MM-DD` key.
     * @param {string} dayKey - a Beijing date key.
     * @returns {number} epoch milliseconds of 00:00 Beijing on that date.
     */
    function beijingMidnightMs(dayKey) {
      const [year, month, day] = dayKey.split('-').map(Number)
      return Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS
    }

    /**
     * The holiday and adjusted-workday entries a calendar holds for one date.
     * @param {{ holidays?: Record<string, string>, workdays?: Record<string, string> } | undefined} calendar - a year calendar or any merge of them.
     * @param {string} dayKey - a Beijing date key.
     * @returns {{ holidayKey: string | null, workdayKey: string | null }} the keys naming that date, when the calendar has them.
     */
    function calendarLookup(calendar, dayKey) {
      const holidays = (calendar && calendar.holidays) || {}
      const workdays = (calendar && calendar.workdays) || {}
      return {
        holidayKey: Object.prototype.hasOwnProperty.call(holidays, dayKey) ? holidays[dayKey] : null,
        workdayKey: Object.prototype.hasOwnProperty.call(workdays, dayKey) ? workdays[dayKey] : null,
      }
    }

    /**
     * Evaluate the published policy for one instant.
     *
     * A peak instant is a minute inside one of the published windows on a Monday
     * to Friday that is not a Chinese public holiday. The windows are UTC minutes,
     * so the minute-of-day is read in UTC; whether the day has a peak at all is a
     * Beijing calendar question. Both windows fall between 00:00 and 16:00 UTC, so
     * a window's UTC date is also its Beijing date.
     *
     * @param {number} ms - epoch milliseconds.
     * @param {{ holidays?: Record<string, string>, workdays?: Record<string, string> } | undefined} calendar - holiday data for the years in play.
     * @returns {{ peak: boolean, reason: 'weekday' | 'weekend' | 'holiday', holidayKey: string | null, workdayKey: string | null, dayKey: string, weekday: number, minuteOfDay: number }} the policy decision with its cause.
     */
    function isPeakInstant(ms, calendar) {
      const parts = beijingParts(ms)
      const dayKey = beijingDayKey(ms)
      const keys = calendarLookup(calendar, dayKey)
      const weekend = parts.weekday === 0 || parts.weekday === 6
      const workingDay = !weekend && keys.holidayKey === null
      const minute = utcMinuteOfDay(ms)
      let inWindow = false
      for (const [start, end] of PEAK_WINDOWS_UTC) {
        if (minute >= start && minute < end) {
          inWindow = true
          break
        }
      }
      return {
        peak: workingDay && inWindow,
        reason: keys.holidayKey !== null ? 'holiday' : weekend ? 'weekend' : 'weekday',
        holidayKey: keys.holidayKey,
        workdayKey: keys.workdayKey,
        dayKey,
        weekday: parts.weekday,
        minuteOfDay: minute,
      }
    }

    /**
     * The instants where the price actually changes, inside a window around `ms`.
     *
     * A window boundary is not a transition when the day has no peak at all
     * (weekend, holiday) or the boundary belongs to another weekend day: the phase
     * before and after such a boundary is the same, so it is skipped. This is what
     * makes Friday 10:00 UTC the next change for a whole weekend.
     *
     * @param {number} ms - epoch milliseconds.
     * @param {{ holidays?: Record<string, string>, workdays?: Record<string, string> } | undefined} calendar - holiday data for the years in play.
     * @returns {{ previous: { at: number, phase: 'peak' | 'off' }, next: { at: number, phase: 'peak' | 'off' } }} the surrounding transitions.
     */
    function transitionsAround(ms, calendar) {
      const todayMidnight = utcMidnightMs(beijingDayKey(ms))
      const transitions = []
      for (let offset = -10; offset <= 10; offset += 1) {
        const base = todayMidnight + offset * DAY_MS
        for (const [start, end] of PEAK_WINDOWS_UTC) {
          for (const minute of [start, end]) {
            const at = base + minute * MINUTE_MS
            const before = isPeakInstant(at - 1, calendar).peak
            const after = isPeakInstant(at, calendar).peak
            if (before === after) continue
            transitions.push({ at, phase: after ? 'peak' : 'off' })
          }
        }
      }
      transitions.sort((left, right) => left.at - right.at)
      let previous = transitions[0]
      let next = transitions[transitions.length - 1]
      for (const transition of transitions) {
        if (transition.at <= ms) previous = transition
        else {
          next = transition
          break
        }
      }
      return { previous, next }
    }

    /**
     * Offset of one timezone at one instant, in milliseconds.
     * @param {number} ms - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @returns {number} the offset east of UTC.
     */
    function zoneOffsetMs(ms, zone) {
      const formatter = formatterFor(`parts|${zone}`, () => new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }))
      const parts = {}
      for (const part of formatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') parts[part.type] = part.value
      }
      const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second),
      )
      return asUtc - ms
    }

    /**
     * The start of the local calendar day that contains an instant.
     * @param {number} ms - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @returns {number} epoch milliseconds of local midnight.
     */
    function localDayStartMs(ms, zone) {
      const offset = zoneOffsetMs(ms, zone)
      const shifted = ms + offset
      const startOfShiftedDay = shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS)
      return startOfShiftedDay - offset
    }

    /**
     * Local clock time of an instant.
     * @param {number} ms - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @param {string} locale - a BCP 47 locale.
     * @returns {string} `HH:MM` in that zone.
     */
    function formatClock(ms, zone, locale) {
      const formatter = formatterFor(`clock|${zone}|${locale}`, () => new Intl.DateTimeFormat(locale || 'en-GB', {
        timeZone: zone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }))
      return formatter.format(new Date(ms))
    }

    /**
     * The UTC offset of a zone at an instant, rendered as `UTC+03:00`.
     * @param {number} ms - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @returns {string} the offset label.
     */
    function formatOffset(ms, zone) {
      const minutes = Math.round(zoneOffsetMs(ms, zone) / MINUTE_MS)
      const sign = minutes < 0 ? '-' : '+'
      const absolute = Math.abs(minutes)
      return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
    }

    /**
     * The peak windows of one Beijing day, as local clock strings.
     * @param {number} ms - epoch milliseconds, selecting the Beijing day.
     * @param {string} zone - an IANA timezone name.
     * @param {string} locale - a BCP 47 locale.
     * @returns {{ startMs: number, endMs: number, startText: string, endText: string, crossesMidnight: boolean }[]} one entry per published window.
     */
    function scheduleWindows(ms, zone, locale) {
      const base = utcMidnightMs(beijingDayKey(ms))
      return PEAK_WINDOWS_UTC.map(([start, end]) => {
        const startMs = base + start * MINUTE_MS
        const endMs = base + end * MINUTE_MS
        const startText = formatClock(startMs, zone, locale)
        const endText = formatClock(endMs, zone, locale)
        return {
          startMs,
          endMs,
          startText,
          endText,
          crossesMidnight: endText < startText,
        }
      })
    }

    /**
     * The local calendar day as a 0..1 band, with every peak stretch inside it.
     *
     * The day is sampled every {@link TIMELINE_STEP_MS}; consecutive peak samples
     * merge into one segment. A daylight-saving day still renders the stretch of
     * the wall-clock day it covers, and the now marker uses the real elapsed share.
     *
     * @param {number} ms - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @param {{ holidays?: Record<string, string>, workdays?: Record<string, string> } | undefined} calendar - holiday data for the years in play.
     * @returns {{ dayStartMs: number, dayMs: number, segments: { from: number, to: number }[], nowFraction: number }} the local day band.
     */
    function timelineOf(ms, zone, calendar) {
      const dayStartMs = localDayStartMs(ms, zone)
      const segments = []
      let open = null
      for (let at = dayStartMs; at < dayStartMs + DAY_MS; at += TIMELINE_STEP_MS) {
        const peak = isPeakInstant(at, calendar).peak
        const from = (at - dayStartMs) / DAY_MS
        if (peak && open === null) open = from
        if (!peak && open !== null) {
          segments.push({ from: open, to: from })
          open = null
        }
      }
      if (open !== null) segments.push({ from: open, to: 1 })
      return {
        dayStartMs,
        dayMs: DAY_MS,
        segments,
        nowFraction: clamp((ms - dayStartMs) / DAY_MS, 0, 1),
      }
    }

    /**
     * How far a target instant is from a reference instant, in local days.
     * @param {number} target - epoch milliseconds.
     * @param {number} now - epoch milliseconds.
     * @param {string} zone - an IANA timezone name.
     * @returns {'today' | 'tomorrow' | 'later'} the relative day.
     */
    function relativeDay(target, now, zone) {
      const todayStart = localDayStartMs(now, zone)
      const targetStart = localDayStartMs(target, zone)
      const days = Math.round((targetStart - todayStart) / DAY_MS)
      if (days <= 0) return 'today'
      if (days === 1) return 'tomorrow'
      return 'later'
    }

    /**
     * Everything the badge and the panel render for one instant.
     * @param {number} ms - epoch milliseconds.
     * @param {{ calendar?: { holidays?: Record<string, string>, workdays?: Record<string, string> }, zone?: string, locale?: string }} options - calendar data, the viewer timezone and the formatting locale.
     * @returns {object} the aggregated view state; see the properties assigned below.
     */
    function state(ms, options) {
      const calendar = options.calendar || {}
      const zone = options.zone || POLICY_ZONE
      const locale = options.locale || 'en-GB'
      const decision = isPeakInstant(ms, calendar)
      const { previous, next } = transitionsAround(ms, calendar)
      const span = next.at - previous.at
      return {
        now: ms,
        zone,
        locale,
        phase: decision.peak ? 'peak' : 'off',
        reason: decision.reason,
        holidayKey: decision.holidayKey,
        workdayKey: decision.workdayKey,
        remainingMs: next.at - ms,
        progress: span > 0 ? clamp((ms - previous.at) / span, 0, 1) : 0,
        windowStartMs: previous.at,
        windowEndMs: next.at,
        next: { at: next.at, phase: next.phase },
        schedule: scheduleWindows(ms, zone, locale),
        timeline: timelineOf(ms, zone, calendar),
        beijingTime: formatClock(ms, POLICY_ZONE, locale),
        offsetLabel: formatOffset(ms, zone),
      }
    }

    /**
     * Split a duration into display parts.
     * @param {number} ms - a non-negative duration.
     * @returns {{ days: number, hours: number, minutes: number, seconds: number, underMinute: boolean }} the parts; every field except the first is a remainder.
     */
    function durationParts(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      return {
        days: Math.floor(total / 86400),
        hours: Math.floor((total % 86400) / 3600),
        minutes: Math.floor((total % 3600) / 60),
        seconds: total % 60,
        underMinute: total < 60,
      }
    }

    /**
     * Compact countdown for the badge: `2:18` above an hour (`h:mm`), `18:05`
     * below it (`mm:ss`), `3д` above a day.
     *
     * The two colon shapes cannot be confused by their range: the hours field is
     * never below 1 and the minutes field is never above 59, so the switch into
     * the `mm:ss` shape is visible the moment the countdown crosses the hour.
     *
     * @param {number} ms - a non-negative duration.
     * @param {string} daySuffix - the localized short day suffix.
     * @returns {string} the compact text.
     */
    function formatCompact(ms, daySuffix) {
      const parts = durationParts(ms)
      if (parts.days > 0) return `${parts.days}${daySuffix}`
      if (parts.hours > 0) return `${parts.hours}:${pad2(parts.minutes)}`
      return `${parts.minutes}:${pad2(parts.seconds)}`
    }

    /**
     * One decimal place of a share, for widths and progress bars.
     * @param {number} value - a 0..1 share.
     * @returns {string} a percentage string.
     */
    function percent(value) {
      return `${(clamp(value, 0, 1) * 100).toFixed(2)}%`
    }
    // #endregion generated:engine

    // #region generated:holidays
    const HOLIDAY_CALENDAR = {
      "source": "holiday-cn (https://github.com/NateScarlet/holiday-cn), transcribed from the State Council notices",
      "papers": {
        "2026": "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
        "2027": "https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm"
      },
      "years": {
        "2026": {
          "holidays": {
            "2026-01-01": "new-year",
            "2026-01-02": "new-year",
            "2026-01-03": "new-year",
            "2026-02-15": "spring-festival",
            "2026-02-16": "spring-festival",
            "2026-02-17": "spring-festival",
            "2026-02-18": "spring-festival",
            "2026-02-19": "spring-festival",
            "2026-02-20": "spring-festival",
            "2026-02-21": "spring-festival",
            "2026-02-22": "spring-festival",
            "2026-02-23": "spring-festival",
            "2026-04-04": "qingming",
            "2026-04-05": "qingming",
            "2026-04-06": "qingming",
            "2026-05-01": "labour-day",
            "2026-05-02": "labour-day",
            "2026-05-03": "labour-day",
            "2026-05-04": "labour-day",
            "2026-05-05": "labour-day",
            "2026-06-19": "dragon-boat",
            "2026-06-20": "dragon-boat",
            "2026-06-21": "dragon-boat",
            "2026-09-25": "mid-autumn",
            "2026-09-26": "mid-autumn",
            "2026-09-27": "mid-autumn",
            "2026-10-01": "national-day",
            "2026-10-02": "national-day",
            "2026-10-03": "national-day",
            "2026-10-04": "national-day",
            "2026-10-05": "national-day",
            "2026-10-06": "national-day",
            "2026-10-07": "national-day"
          },
          "workdays": {
            "2026-01-04": "new-year",
            "2026-02-14": "spring-festival",
            "2026-02-28": "spring-festival",
            "2026-05-09": "labour-day",
            "2026-09-20": "national-day",
            "2026-10-10": "national-day"
          }
        },
        "2027": {
          "holidays": {
            "2027-01-01": "new-year",
            "2027-01-02": "new-year",
            "2027-01-03": "new-year",
            "2027-02-05": "spring-festival",
            "2027-02-06": "spring-festival",
            "2027-02-07": "spring-festival",
            "2027-02-08": "spring-festival",
            "2027-02-09": "spring-festival",
            "2027-02-10": "spring-festival",
            "2027-02-11": "spring-festival",
            "2027-02-12": "spring-festival",
            "2027-02-13": "spring-festival",
            "2027-04-03": "qingming",
            "2027-04-04": "qingming",
            "2027-04-05": "qingming",
            "2027-05-01": "labour-day",
            "2027-05-02": "labour-day",
            "2027-05-03": "labour-day",
            "2027-05-04": "labour-day",
            "2027-05-05": "labour-day",
            "2027-06-09": "dragon-boat",
            "2027-09-15": "mid-autumn",
            "2027-10-01": "national-day",
            "2027-10-02": "national-day",
            "2027-10-03": "national-day",
            "2027-10-04": "national-day",
            "2027-10-05": "national-day",
            "2027-10-06": "national-day",
            "2027-10-07": "national-day"
          },
          "workdays": {
            "2027-01-31": "spring-festival",
            "2027-02-14": "spring-festival",
            "2027-05-08": "labour-day",
            "2027-09-26": "national-day",
            "2027-10-09": "national-day"
          }
        }
      }
    }
    // #endregion generated:holidays

    // ─── Dictionaries ───────────────────────────────────────────────────────

    const EN = {
      'badge.peak': 'Peak',
      'badge.off': 'Off-peak',
      'badge.aria': 'DeepSeek {state}, {time} until the price changes',
      'badge.detached': 'DeepSeek’s schedule does not apply to this model',
      'daysShort': 'd',
      'state.untilOff': 'until the discount',
      'state.untilPeak': 'until peak',
      'panel.title': 'DeepSeek price clock',
      'panel.close': 'Close',
      'panel.rate.peak': 'full price',
      'panel.rate.off': 'half price',
      'panel.notApplicable': 'not applicable',
      'panel.next.peak': 'Peak starts {when} at {time}',
      'panel.next.off': 'Half price starts {when} at {time}',
      'time.today': 'today',
      'time.tomorrow': 'tomorrow',
      'rows.peakHours': 'Peak hours',
      'rows.policyDay': 'Day (Beijing)',
      'rows.zone': 'Your zone',
      'rows.beijing': 'Beijing',
      'rows.model': 'Model',
      'rows.updated': 'Prices checked',
      'reason.weekday': 'weekday',
      'reason.weekend': 'weekend',
      'reason.holiday': 'holiday: {name}',
      'reason.workday': 'make-up workday',
      'holiday.new-year': 'New Year\'s Day',
      'holiday.spring-festival': 'Spring Festival',
      'holiday.qingming': 'Qingming Festival',
      'holiday.labour-day': 'Labour Day',
      'holiday.dragon-boat': 'Dragon Boat Festival',
      'holiday.mid-autumn': 'Mid-Autumn Festival',
      'holiday.national-day': 'National Day',
      'holiday.holiday': 'public holiday',
      'prices.title': 'Prices, {currency} per 1M tokens',
      'prices.hit': 'input · cache hit',
      'prices.miss': 'input · cache miss',
      'prices.output': 'output',
      'prices.peak': 'peak',
      'prices.off': 'off-peak',
      'prices.source': 'DeepSeek pricing page',
      'money.title': 'Money',
      'money.balance': 'Balance',
      'money.bonus': 'bonus',
      'money.session': 'This session',
      'money.sessionIn': 'This session, {currency}',
      'money.requests': '{n} requests',
      'money.loading': 'reading…',
      'money.signedOut': 'not signed in',
      'money.failed': 'unavailable',
      'money.unavailable': 'account service is not mounted',
      'money.noSession': 'no session yet',
      'money.asOf': 'as of {time}',
      'money.estimate': '≈ ',
      'model.unknown': 'unknown model',
      'model.notDirect': 'This model is served by {provider}; DeepSeek’s peak schedule does not apply to it.',
      'model.unknownProvider': 'The provider is not known yet, so this session’s spend is not attributed.',
      'warn.holiday': 'The holiday calendar did not load; only weekdays are considered.',
      'warn.finance': 'Balance and spend could not be read.',
      'warn.inexact': 'The total is partial: {n} messages carried no token usage.',
      'warn.unknownModel': 'Unpriced models: {models}',
      'warn.calendarYears': 'The holiday calendar for {years} is unavailable; weekdays only.',
      'refresh': 'Refresh',
      'duration.hm': '{h} h {m} min',
      'duration.dh': '{d} d {h} h',
      'duration.d': '{d} d',
      'duration.h': '{h} h',
      'duration.ms': '{m} min {s} s',
      'duration.s': '{s} s',
      'duration.soon': 'under a second',
    }

    const RU = {
      'badge.peak': 'Пик',
      'badge.off': 'Вне пика',
      'badge.aria': 'DeepSeek: {state}, до смены цены {time}',
      'badge.detached': 'Тариф DeepSeek не применяется к этой модели',
      'daysShort': 'д',
      'state.untilOff': 'до половины цены',
      'state.untilPeak': 'до пика',
      'panel.title': 'Пиковые часы DeepSeek',
      'panel.close': 'Закрыть',
      'panel.rate.peak': 'полная цена',
      'panel.rate.off': 'половина цены',
      'panel.notApplicable': 'не применяется',
      'panel.next.peak': 'Пик начнётся {when} в {time}',
      'panel.next.off': 'Половина цены начнётся {when} в {time}',
      'time.today': 'сегодня',
      'time.tomorrow': 'завтра',
      'rows.peakHours': 'Часы пик',
      'rows.policyDay': 'День (Пекин)',
      'rows.zone': 'Ваша зона',
      'rows.beijing': 'Пекин',
      'rows.model': 'Модель',
      'rows.updated': 'Цены проверены',
      'reason.weekday': 'будний день',
      'reason.weekend': 'выходной',
      'reason.holiday': 'праздник: {name}',
      'reason.workday': 'перенесённый рабочий день',
      'holiday.new-year': 'Новый год',
      'holiday.spring-festival': 'Праздник весны',
      'holiday.qingming': 'Цинмин',
      'holiday.labour-day': 'День труда',
      'holiday.dragon-boat': 'Праздник драконьих лодок',
      'holiday.mid-autumn': 'Праздник середины осени',
      'holiday.national-day': 'День образования КНР',
      'holiday.holiday': 'государственный праздник',
      'prices.title': 'Цены, {currency} за 1 млн токенов',
      'prices.hit': 'вход · из кэша',
      'prices.miss': 'вход · без кэша',
      'prices.output': 'выход',
      'prices.peak': 'пик',
      'prices.off': 'вне пика',
      'prices.source': 'страница цен DeepSeek',
      'money.title': 'Деньги',
      'money.balance': 'Баланс',
      'money.bonus': 'бонус',
      'money.session': 'Эта сессия',
      'money.sessionIn': 'Эта сессия, {currency}',
      'money.requests': 'запросов: {n}',
      'money.loading': 'загрузка…',
      'money.signedOut': 'нет входа в аккаунт',
      'money.failed': 'не удалось загрузить',
      'money.unavailable': 'сервис аккаунта не подключён',
      'money.noSession': 'сессии пока нет',
      'money.asOf': 'данные на {time}',
      'money.estimate': '≈ ',
      'model.unknown': 'неизвестная модель',
      'model.notDirect': 'Модель обслуживает {provider}; пиковый тариф DeepSeek к ней не применяется.',
      'model.unknownProvider': 'Провайдер модели ещё не определён, расход по ней не показываю.',
      'warn.holiday': 'Календарь праздников не загрузился — учитываются только будни.',
      'warn.finance': 'Баланс и расход прочитать не удалось.',
      'warn.inexact': 'Сумма неполная: сообщений без данных о токенах — {n}.',
      'warn.unknownModel': 'Модели без цены: {models}',
      'warn.calendarYears': 'Календарь праздников за {years} недоступен — учитываются только будни.',
      'refresh': 'Обновить',
      'duration.hm': '{h} ч {m} мин',
      'duration.dh': '{d} д {h} ч',
      'duration.d': '{d} д',
      'duration.h': '{h} ч',
      'duration.ms': '{m} мин {s} с',
      'duration.s': '{s} с',
      'duration.soon': 'меньше секунды',
    }

    const ZH = {
      'badge.peak': '高峰',
      'badge.off': '空闲',
      'badge.aria': 'DeepSeek {state}，距价格变化 {time}',
      'badge.detached': '当前模型不适用 DeepSeek 时段价格',
      'daysShort': '天',
      'state.untilOff': '距半价',
      'state.untilPeak': '距高峰',
      'panel.title': 'DeepSeek 价格时钟',
      'panel.close': '关闭',
      'panel.rate.peak': '全价',
      'panel.rate.off': '半价',
      'panel.notApplicable': '不适用',
      'panel.next.peak': '高峰将于{when} {time} 开始',
      'panel.next.off': '半价将于{when} {time} 开始',
      'time.today': '今天',
      'time.tomorrow': '明天',
      'rows.peakHours': '高峰时段',
      'rows.policyDay': '日期（北京）',
      'rows.zone': '所在时区',
      'rows.beijing': '北京',
      'rows.model': '模型',
      'rows.updated': '价格核对',
      'reason.weekday': '工作日',
      'reason.weekend': '周末',
      'reason.holiday': '节假日：{name}',
      'reason.workday': '调休上班日',
      'holiday.new-year': '元旦',
      'holiday.spring-festival': '春节',
      'holiday.qingming': '清明节',
      'holiday.labour-day': '劳动节',
      'holiday.dragon-boat': '端午节',
      'holiday.mid-autumn': '中秋节',
      'holiday.national-day': '国庆节',
      'holiday.holiday': '法定节假日',
      'prices.title': '价格，{currency} / 百万 tokens',
      'prices.hit': '输入 · 命中缓存',
      'prices.miss': '输入 · 未命中缓存',
      'prices.output': '输出',
      'prices.peak': '高峰',
      'prices.off': '空闲',
      'prices.source': 'DeepSeek 价格页',
      'money.title': '费用',
      'money.balance': '余额',
      'money.bonus': '赠金',
      'money.session': '本会话',
      'money.sessionIn': '本会话（{currency}）',
      'money.requests': '{n} 次请求',
      'money.loading': '读取中…',
      'money.signedOut': '未登录',
      'money.failed': '读取失败',
      'money.unavailable': '账户服务未挂载',
      'money.noSession': '暂无会话',
      'money.asOf': '{time} 时数据',
      'money.estimate': '≈ ',
      'model.unknown': '未知模型',
      'model.notDirect': '当前模型由 {provider} 提供，不适用 DeepSeek 峰谷价格。',
      'model.unknownProvider': '当前模型的提供方尚未确定，因此不显示该会话花费。',
      'warn.holiday': '节假日日历未加载，仅按工作日判断。',
      'warn.finance': '余额与花费读取失败。',
      'warn.inexact': '合计不完整：{n} 条消息没有 token 用量。',
      'warn.unknownModel': '未定价模型：{models}',
      'warn.calendarYears': '{years} 年节假日日历不可用，仅按工作日判断。',
      'refresh': '刷新',
      'duration.hm': '{h} 小时 {m} 分',
      'duration.dh': '{d} 天 {h} 小时',
      'duration.d': '{d} 天',
      'duration.h': '{h} 小时',
      'duration.ms': '{m} 分 {s} 秒',
      'duration.s': '{s} 秒',
      'duration.soon': '不到一秒',
    }

    // ─── Styles ─────────────────────────────────────────────────────────────

    const CSS = `
.dpc-root { display: inline-flex; align-items: center; }
.dpc-badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; }
.dpc-badge:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dpc-badge:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dpc-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-warn-primary); }
.dpc-root[data-phase="off"] .dpc-dot,
.dpc-panel[data-phase="off"] .dpc-dot { background: var(--dsw-alias-state-success-primary); }
.dpc-root[data-detached="true"] .dpc-dot,
.dpc-panel[data-detached="true"] .dpc-dot { background: var(--dsw-alias-label-tertiary); }
.dpc-time { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dpc-panel { position: fixed; z-index: 2147483000; box-sizing: border-box; width: min(340px, calc(100vw - 16px)); max-height: min(72vh, 560px); overflow: auto; padding: 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.45; box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dpc-head { display: flex; align-items: center; gap: 8px; }
.dpc-state { font-size: 13px; font-weight: 600; }
.dpc-chip { padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); color: var(--dsw-alias-label-primary); font-size: 11px; }
.dpc-panel[data-phase="off"] .dpc-chip { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.dpc-panel[data-detached="true"] .dpc-chip { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dpc-close { margin-left: auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
.dpc-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dpc-count { margin-top: 10px; display: flex; align-items: baseline; gap: 6px; }
.dpc-count-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dpc-count-until { color: var(--dsw-alias-label-secondary); }
.dpc-band { position: relative; margin-top: 18px; }
.dpc-now-label { position: absolute; bottom: 100%; margin-bottom: 1px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dpc-now-label[data-edge="mid"] { transform: translateX(-50%); }
.dpc-now-label[data-edge="end"] { transform: translateX(-100%); }
.dpc-track { position: relative; height: 6px; border-radius: 999px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.dpc-seg { position: absolute; top: 0; bottom: 0; background: var(--dsw-alias-state-warn-primary); }
.dpc-now { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; background: var(--dsw-alias-label-primary); }
.dpc-ticks { position: relative; height: 15px; margin-top: 3px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dpc-tick { position: absolute; top: 0; white-space: nowrap; }
.dpc-tick[data-edge="start"] { transform: translateX(0); }
.dpc-tick[data-edge="mid"] { transform: translateX(-50%); }
.dpc-tick[data-edge="end"] { transform: translateX(-100%); }
.dpc-next { margin-top: 8px; color: var(--dsw-alias-label-secondary); }
.dpc-sect { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dpc-sect-title { color: var(--dsw-alias-label-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.dpc-row { display: flex; gap: 10px; margin-top: 6px; }
.dpc-row-key { flex: none; min-width: 96px; color: var(--dsw-alias-label-secondary); }
.dpc-row-value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dpc-model { display: flex; flex-direction: column; }
.dpc-model-name { overflow-wrap: anywhere; }
.dpc-model-provider { color: var(--dsw-alias-label-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.dpc-summary { display: flex; align-items: center; gap: 6px; width: 100%; cursor: pointer; list-style: none; }
.dpc-summary::-webkit-details-marker { display: none; }
.dpc-summary:hover { color: var(--dsw-alias-label-primary); }
/* A drawn triangle, not a glyph: ▸ falls back to a tofu box in some font stacks. */
.dpc-summary::before { content: ''; width: 0; height: 0; border-left: 4px solid var(--dsw-alias-label-tertiary); border-top: 3px solid transparent; border-bottom: 3px solid transparent; transition: transform 120ms ease; }
.dpc-details[open] > .dpc-summary::before { transform: rotate(90deg); }
.dpc-details[open] > .dpc-summary { margin-bottom: 2px; }
.dpc-price-model { margin-top: 8px; display: flex; align-items: baseline; gap: 6px; }
.dpc-price-model-name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dpc-price-model-slot { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dpc-price-grid { display: grid; grid-template-columns: 1fr auto auto; gap: 2px 10px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.dpc-price-grid > span:nth-child(3n+2), .dpc-price-grid > span:nth-child(3n) { text-align: right; }
.dpc-price-head { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dpc-warn { margin-top: 8px; color: var(--dsw-alias-state-warn-label); }
.dpc-note { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.dpc-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dpc-refresh { margin-left: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; padding: 2px 7px; cursor: pointer; }
.dpc-refresh:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dpc-refresh:disabled { opacity: 0.5; cursor: default; }
.dpc-link { color: var(--dsw-alias-link); text-decoration: none; }
.dpc-link:hover { text-decoration: underline; }
`

    // ─── Calendar store ─────────────────────────────────────────────────────

    /** year -> { value: { holidays, workdays, source, degraded }, promise } */
    const calendarYears = new Map()
    const calendarListeners = new Set()

    /** The stable answer for a year that has no data yet. */
    const EMPTY_CALENDAR = Object.freeze({
      holidays: Object.freeze({}),
      workdays: Object.freeze({}),
      source: 'pending',
      degraded: false,
    })

    /**
     * The bundled calendar of one year, in the shape the engine reads.
     * @param {number} year - a four-digit year.
     * @returns {{ holidays: Record<string, string>, workdays: Record<string, string>, source: string, degraded: boolean } | null} the entries, or null when the year is not bundled.
     */
    function bundledCalendar(year) {
      const entry = HOLIDAY_CALENDAR.years[String(year)]
      if (entry === undefined) return null
      return {
        holidays: entry.holidays || {},
        workdays: entry.workdays || {},
        source: 'bundled',
        degraded: false,
      }
    }

    /**
     * The calendar object for one year, stable between changes.
     * @param {number} year - a four-digit year.
     * @returns {{ holidays: Record<string, string>, workdays: Record<string, string>, source: string, degraded: boolean }} the entries, empty while a year outside the bundle loads.
     */
    function snapshotYear(year) {
      const record = calendarYears.get(year)
      if (record !== undefined && record.value !== undefined) return record.value
      const bundled = bundledCalendar(year)
      if (bundled !== null) {
        // Cached once so `useSyncExternalStore` sees the same reference on
        // every read; a fresh object per call would re-render forever.
        calendarYears.set(year, { value: bundled, promise: null })
        return bundled
      }
      return EMPTY_CALENDAR
    }

    /**
     * Load a year that the bundle does not cover, once.
     * @param {number} year - a four-digit year.
     * @returns {void}
     */
    function ensureYear(year) {
      if (calendarYears.has(year)) return
      if (bundledCalendar(year) !== null) {
        snapshotYear(year)
        return
      }
      const record = { value: undefined, promise: null }
      calendarYears.set(year, record)
      record.promise = (async () => {
        try {
          const response = await fetch(`${HOLIDAYS_ROUTE}?year=${year}`, {
            headers: { accept: 'application/json' },
            signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
          })
          if (!response.ok) throw new Error(`holidays ${response.status}`)
          const body = await response.json()
          record.value = {
            holidays: body && body.holidays ? body.holidays : {},
            workdays: body && body.workdays ? body.workdays : {},
            source: body && body.source ? body.source : 'host',
            degraded: body === null || body.degraded === true,
          }
        } catch {
          record.value = { holidays: {}, workdays: {}, source: 'unavailable', degraded: true }
        }
        for (const listener of calendarListeners) listener()
      })()
    }

    /**
     * Drop the cached calendar of a year and load it again. The bundled years
     * need no retry: they are already exact and offline.
     * @param {number} year - a four-digit year.
     * @returns {void}
     */
    function retryCalendar(year) {
      const record = calendarYears.get(year)
      if (record !== undefined && (record.promise === null || record.promise === undefined)) return
      calendarYears.delete(year)
      ensureYear(year)
      for (const listener of calendarListeners) listener()
    }

    /**
     * Subscribe to the calendar of the Beijing year that contains an instant.
     * @param {number} year - a four-digit year.
     * @returns {{ holidays: Record<string, string>, workdays: Record<string, string>, source: string, degraded: boolean }} the calendar.
     */
    function useCalendar(year) {
      const subscribe = React.useCallback((notify) => {
        calendarListeners.add(notify)
        return () => calendarListeners.delete(notify)
      }, [])
      const read = React.useCallback(() => snapshotYear(year), [year])
      React.useEffect(() => {
        ensureYear(year)
      }, [year])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    // ─── Locale and time hooks ──────────────────────────────────────────────

    /**
     * Subscribe to the Client locale snapshot.
     * @param {object} ctx - the browser context.
     * @returns {object | null} the snapshot, or null when the service is absent.
     */
    function useLocaleSnapshot(ctx) {
      const subscribe = React.useCallback(
        (notify) => (ctx.locale && typeof ctx.locale.subscribe === 'function' ? ctx.locale.subscribe(notify) : () => {}),
        [ctx],
      )
      const read = React.useCallback(
        () => (ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null),
        [ctx],
      )
      return React.useSyncExternalStore(subscribe, read, () => null)
    }

    /**
     * The active UI language, as a bare language tag.
     * @param {object | null} snapshot - the locale snapshot.
     * @returns {string} a language such as `ru` or `en`.
     */
    function activeLanguage(snapshot) {
      const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
      if (active !== '') return active.toLowerCase().split(/[-_]/)[0]
      const fallback = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'en'
      return fallback.toLowerCase().split(/[-_]/)[0]
    }

    /**
     * A BCP 47 tag for `Intl` formatting of one language.
     * @param {string} language - a bare language tag.
     * @returns {string} the formatting locale.
     */
    function formattingLocale(language) {
      if (language === 'ru') return 'ru-RU'
      if (language === 'zh') return 'zh-CN'
      if (language === 'en') return 'en-GB'
      return language || 'en-GB'
    }

    /**
     * The viewer timezone, resolved once per mount.
     * @returns {string} an IANA timezone name.
     */
    function useZone() {
      const [zone] = React.useState(() => {
        try {
          const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
          return typeof resolved === 'string' && resolved !== '' ? resolved : POLICY_ZONE
        } catch {
          return POLICY_ZONE
        }
      })
      return zone
    }

    /**
     * A ticking clock that stops while the page is hidden.
     * @param {number} intervalMs - the tick interval.
     * @returns {number} the current epoch milliseconds.
     */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        setNow(Date.now())
        let timer = null
        const start = () => {
          if (timer === null) timer = setInterval(() => setNow(Date.now()), intervalMs)
        }
        const stop = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const onVisibility = () => {
          setNow(Date.now())
          if (document.hidden) stop()
          else start()
        }
        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [intervalMs])
      return now
    }

    /**
     * Format a duration through the dictionaries.
     *
     * The badge rounds to minutes above an hour and to seconds below it, and
     * the tooltip keeps the same resolution so the two never disagree.
     *
     * @param {Function} t - the translate function.
     * @param {number} ms - the duration.
     * @returns {string} the localized text.
     */
    function durationText(t, ms) {
      const parts = durationParts(ms)
      if (parts.days > 0) {
        return parts.hours > 0
          ? t('duration.dh', { d: parts.days, h: parts.hours })
          : t('duration.d', { d: parts.days })
      }
      if (parts.hours > 0 && parts.minutes > 0) return t('duration.hm', { h: parts.hours, m: parts.minutes })
      if (parts.hours > 0) return t('duration.h', { h: parts.hours })
      if (parts.minutes > 0) return t('duration.ms', { m: parts.minutes, s: parts.seconds })
      if (parts.seconds > 0) return t('duration.s', { s: parts.seconds })
      return t('duration.soon')
    }

    /**
     * A short date for a change that is neither today nor tomorrow.
     * @param {number} ms - the instant.
     * @param {string} zone - the viewer timezone.
     * @param {string} locale - the formatting locale.
     * @returns {string} the date text.
     */
    function formatDate(ms, zone, locale) {
      try {
        return new Intl.DateTimeFormat(locale, { timeZone: zone, day: 'numeric', month: 'short', weekday: 'short' }).format(new Date(ms))
      } catch {
        return formatClock(ms, zone, locale)
      }
    }

    /**
     * A `YYYY-MM-DD` key as a localized date.
     * @param {string} dateKey - an ISO date.
     * @param {string} locale - the formatting locale.
     * @returns {string} the localized date.
     */
    function formatIsoDate(dateKey, locale) {
      const parts = String(dateKey).split('-').map(Number)
      if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return String(dateKey)
      try {
        return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' })
          .format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12)))
      } catch {
        return String(dateKey)
      }
    }

    /**
     * Format an amount in the table's currency.
     * @param {number} amount - the amount.
     * @param {string | null} currency - the currency code.
     * @param {number} digits - decimal places.
     * @returns {string} the formatted amount.
     */
    function formatMoney(amount, currency, digits) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
      const text = amount.toFixed(digits)
      return symbol === '' ? `${text} ${currency || ''}`.trim() : `${symbol}${text}`
    }

    // ─── Model selection ────────────────────────────────────────────────────

    /**
     * Read the current model and provider: the session selection projection
     * first, the composer's model directory second.
     * @param {object} props - slot props.
     * @param {object} ctx - the browser context.
     * @returns {{ model: string | null, provider: string | null }} the selection, with null fields while it is unknown.
     */
    function useSelection(props, ctx) {
      const sessionId = props.sessionId
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : null
      const projected = useProjection === null ? undefined : useProjection('modelSelection')

      const directory = React.useMemo(() => {
        if (sessionId === undefined || sessionId === null) return null
        // `ctx.get` is the optional-service accessor: reading `ctx.modelDirectories`
        // directly throws in Cordis unless the plugin declares the service in
        // `inject`, and this badge must keep working in compositions without the
        // model selector.
        const service = typeof ctx.get === 'function' ? ctx.get('modelDirectories') : null
        if (service === undefined || service === null || typeof service.directoryFor !== 'function') return null
        try {
          const found = service.directoryFor(sessionId)
          return found === null || found === undefined ? null : found.store
        } catch {
          return null
        }
      }, [ctx, sessionId])

      const subscribe = React.useCallback(
        (notify) => (directory === null ? () => {} : directory.subscribe(notify)),
        [directory],
      )
      const read = React.useCallback(
        () => (directory === null ? null : directory.getSnapshot()),
        [directory],
      )
      const snapshot = React.useSyncExternalStore(subscribe, read, () => null)

      const pick = (selection) => {
        if (selection === null || selection === undefined) return null
        const provider = typeof selection.provider === 'string' ? selection.provider : null
        const model = typeof selection.model === 'string' ? selection.model : null
        return { model, provider }
      }
      const fromDirectory = pick(snapshot ? snapshot.current : null)
      if (fromDirectory !== null) return fromDirectory
      const fromProjection = pick(projected ? projected.next : null)
      if (fromProjection !== null) return fromProjection
      return { model: null, provider: null }
    }

    // ─── Host data ──────────────────────────────────────────────────────────

    /**
     * Read the finance payload while the panel is open.
     *
     * The last good answer stays visible across a failed refresh, and a new
     * session drops it instead of showing another session's spend.
     *
     * @param {object} options - what to read.
     * @param {string | null} options.sessionId - the current session.
     * @param {boolean} options.active - whether the panel is open.
     * @param {string} options.language - the active UI language.
     * @param {number} options.revision - the manual refresh counter.
     * @returns {{ data: object | null, status: string, loading: boolean }} the payload and its freshness.
     */
    function useFinance(options) {
      const { sessionId, active, language, revision } = options
      const [state, setState] = React.useState({ data: null, sessionId: null, status: 'idle' })
      const generation = React.useRef(0)

      const refresh = React.useCallback(async (silent) => {
        const current = ++generation.current
        if (!silent) setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        const query = new URLSearchParams()
        if (sessionId !== null) query.set('sessionId', String(sessionId))
        query.set('locale', language)
        const offsetSeconds = -new Date().getTimezoneOffset() * 60
        query.set('tz', String(offsetSeconds))
        try {
          const response = await fetch(`${FINANCE_ROUTE}?${query.toString()}`, {
            headers: { accept: 'application/json' },
            signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
          })
          if (!response.ok) throw new Error(`finance ${response.status}`)
          const body = await response.json()
          if (current !== generation.current) return
          if (!body || body.ok !== true) throw new Error('finance payload')
          setState({ data: body, sessionId: sessionId === null ? null : String(sessionId), status: 'ready' })
        } catch {
          if (current !== generation.current) return
          setState((previous) => ({ ...previous, status: previous.data === null ? 'error' : 'stale' }))
        }
      }, [sessionId, language])

      React.useEffect(() => {
        if (!active) return undefined
        refresh(false)
        const timer = setInterval(() => refresh(true), FINANCE_TTL_MS)
        return () => clearInterval(timer)
      }, [active, refresh, revision])

      const data = state.sessionId !== null && state.sessionId !== (sessionId === null ? null : String(sessionId)) ? null : state.data
      return { data, status: state.status }
    }

    // ─── Panel ──────────────────────────────────────────────────────────────

    /**
     * The 24-hour band of the viewer's local day with every peak stretch in it.
     *
     * The marker carries the local time it stands for, and hugs the nearest
     * edge of the band instead of overflowing it when the day is nearly over.
     *
     * @param {object} snapshot - the engine state.
     * @param {string} locale - the formatting locale.
     * @returns {object} the timeline element.
     */
    function Timeline(snapshot, locale) {
      const { timeline, zone } = snapshot
      const fractions = [0, 0.25, 0.5, 0.75, 1]
      const ticks = fractions.map((fraction, index) => ({
        fraction,
        label: index === fractions.length - 1
          ? '24:00'
          : formatClock(timeline.dayStartMs + fraction * timeline.dayMs, zone, locale),
      }))
      const nowFraction = clamp(timeline.nowFraction, 0, 1)
      const nowEdge = nowFraction <= 0.05 ? 'start' : nowFraction >= 0.95 ? 'end' : 'mid'
      return h('div', { key: 'timeline', 'aria-hidden': 'true' }, [
        h('div', { key: 'band', className: 'dpc-band' }, [
          h('span', {
            key: 'now-label',
            className: 'dpc-now-label',
            'data-edge': nowEdge,
            style: { left: percent(nowFraction) },
          }, formatClock(snapshot.now, zone, locale)),
          h('div', { key: 'track', className: 'dpc-track' }, [
            ...timeline.segments.map((segment, index) => h('span', {
              key: `seg-${index}`,
              className: 'dpc-seg',
              style: { left: percent(segment.from), width: percent(segment.to - segment.from) },
            })),
            h('span', { key: 'now', className: 'dpc-now', style: { left: percent(nowFraction) } }),
          ]),
        ]),
        // Each label sits on its own instant, so the axis matches the bar; the
        // first and last labels hug the edges instead of overflowing them.
        h('div', { key: 'ticks', className: 'dpc-ticks' },
          ticks.map((tick, index) => h('span', {
            key: `tick-${index}`,
            className: 'dpc-tick',
            'data-edge': index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'mid',
            style: { left: percent(tick.fraction) },
          }, tick.label))),
      ])
    }

    /**
     * One model's published prices in both windows.
     * @param {object} options - the model entry and the table header labels.
     * @returns {object} the model price block.
     */
    function PriceBlock(options) {
      const { model, t } = options
      const cells = [
        [t('prices.hit'), model.peak.cacheHit, model.off.cacheHit],
        [t('prices.miss'), model.peak.cacheMiss, model.off.cacheMiss],
        [t('prices.output'), model.peak.output, model.off.output],
      ]
      return h('div', { key: `price-${model.id}`, className: 'dpc-price-model-block' }, [
        h('div', { key: 'name', className: 'dpc-price-model' }, [
          h('span', { key: 'id', className: 'dpc-price-model-name' }, model.id),
        ]),
        h('div', { key: 'grid', className: 'dpc-price-grid' }, [
          h('span', { key: 'h0', className: 'dpc-price-head' }, ''),
          h('span', { key: 'h1', className: 'dpc-price-head' }, t('prices.peak')),
          h('span', { key: 'h2', className: 'dpc-price-head' }, t('prices.off')),
          ...cells.flatMap(([label, peak, off], index) => [
            h('span', { key: `l${index}`, className: 'dpc-row-key' }, label),
            h('span', { key: `p${index}` }, String(peak)),
            h('span', { key: `o${index}` }, String(off)),
          ]),
        ]),
      ])
    }

    /**
     * The detail panel.
     *
     * The panel always explains the current DeepSeek window. Prices and the
     * session spend appear only for a route DeepSeek bills itself; the balance
     * is account-wide, so it appears for every route.
     *
     * @param {object} props - rendering inputs.
     * @param {string} props.id - the element id the badge's aria-controls names.
     * @param {object} props.snapshot - the engine state for this second.
     * @param {Function} props.t - the translate function.
     * @param {string} props.locale - the formatting locale.
     * @param {{ model: string | null, provider: string | null }} props.selection - the current model selection.
     * @param {object | null} props.finance - the Host finance payload.
     * @param {string} props.financeStatus - loading, refreshing, ready, stale or error.
     * @param {boolean} props.holidayDegraded - whether the calendar fell back to weekdays.
     * @param {Function} props.onRefresh - manual refresh of the finance payload and the calendar.
     * @param {Function} props.onClose - close request that restores the previous focus.
     * @param {Function} props.bindOutside - attaches the panel element.
     * @param {object} props.style - the viewport position.
     * @returns {object} the panel element.
     */
    function Panel(props) {
      const { snapshot, t, locale, selection, finance, financeStatus, holidayDegraded, onRefresh, onClose } = props
      const direct = isDeepSeekRoute(selection.provider)
      const detached = selection.provider !== null && !direct
      const unknownProvider = selection.provider === null
      const clock = (ms) => formatClock(ms, snapshot.zone, locale)

      const nextWhen = relativeDay(snapshot.next.at, snapshot.now, snapshot.zone)
      const nextWhenLabel = nextWhen === 'today'
        ? t('time.today')
        : nextWhen === 'tomorrow'
          ? t('time.tomorrow')
          : formatDate(snapshot.next.at, snapshot.zone, locale)
      const nextLine = snapshot.next.phase === 'peak'
        ? t('panel.next.peak', { when: nextWhenLabel, time: clock(snapshot.next.at) })
        : t('panel.next.off', { when: nextWhenLabel, time: clock(snapshot.next.at) })

      let reasonText
      if (snapshot.reason === 'holiday' && snapshot.holidayKey !== null) {
        reasonText = t('reason.holiday', { name: t(`holiday.${snapshot.holidayKey}`) })
      } else if (snapshot.reason === 'weekend') {
        reasonText = snapshot.workdayKey === null ? t('reason.weekend') : `${t('reason.weekend')} · ${t('reason.workday')}`
      } else {
        reasonText = t('reason.weekday')
      }

      const scheduleText = snapshot.schedule.map((window) => `${window.startText}–${window.endText}`).join(' · ')
      const pricing = finance && finance.pricing
        ? finance.pricing
        : {
          currency: PRICING_CURRENCY,
          updated: PRICING_UPDATED,
          source: PRICING_SOURCE,
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

      const rows = [
        h('div', { key: 'hours', className: 'dpc-row' }, [
          h('span', { key: 'k', className: 'dpc-row-key' }, t('rows.peakHours')),
          h('span', { key: 'v', className: 'dpc-row-value' }, scheduleText),
        ]),
        h('div', { key: 'day', className: 'dpc-row' }, [
          h('span', { key: 'k', className: 'dpc-row-key' }, t('rows.policyDay')),
          h('span', { key: 'v', className: 'dpc-row-value' }, reasonText),
        ]),
        h('div', { key: 'zone', className: 'dpc-row' }, [
          h('span', { key: 'k', className: 'dpc-row-key' }, t('rows.zone')),
          h('span', { key: 'v', className: 'dpc-row-value' }, `${snapshot.zone} · ${snapshot.offsetLabel}`),
        ]),
        h('div', { key: 'beijing', className: 'dpc-row' }, [
          h('span', { key: 'k', className: 'dpc-row-key' }, t('rows.beijing')),
          h('span', { key: 'v', className: 'dpc-row-value' }, `${snapshot.beijingTime} · UTC+08:00`),
        ]),
        selection.model === null
          ? null
          : h('div', { key: 'model', className: 'dpc-row' }, [
            h('span', { key: 'k', className: 'dpc-row-key' }, t('rows.model')),
            // The provider sits under the model, not beside it: a long pair
            // wrapped mid-token in the composer and read as one broken name.
            h('span', { key: 'v', className: 'dpc-row-value dpc-model' }, [
              h('span', { key: 'name', className: 'dpc-model-name', title: selection.model }, selection.model),
              selection.provider === null
                ? null
                : h('span', { key: 'provider', className: 'dpc-model-provider', title: selection.provider }, selection.provider),
            ]),
          ]),
      ]

      const balance = finance ? finance.balance : null
      let balanceText
      if (financeStatus === 'error' && finance === null) balanceText = t('money.failed')
      else if (balance === null) balanceText = t('money.loading')
      else if (balance.status === 'ready') {
        const main = formatMoney(balance.amount, balance.currency, 2)
        balanceText = balance.bonus === null || balance.bonus === undefined
          ? main
          : `${main} · ${t('money.bonus')} ${formatMoney(balance.bonus, balance.currency, 2)}`
      } else if (balance.status === 'signed-out') balanceText = t('money.signedOut')
      else if (balance.status === 'unavailable') balanceText = t('money.unavailable')
      else balanceText = t('money.failed')

      const spend = finance ? finance.spend : null
      let spendText = null
      if (direct) {
        if (financeStatus === 'error' && finance === null) spendText = t('money.failed')
        else if (spend === null) spendText = t('money.loading')
        else if (spend.status === 'no-session') spendText = t('money.noSession')
        else if (spend.status === 'ready') {
          const digits = spend.total < 1 ? 4 : 3
          const prefix = spend.exact ? '' : t('money.estimate')
          spendText = `${prefix}${formatMoney(spend.total, pricing.currency, digits)} · ${t('money.requests', { n: spend.requests })}`
        } else if (spend.status === 'unavailable') spendText = t('money.unavailable')
        else spendText = t('money.failed')
      }

      const warnings = []
      if (holidayDegraded) warnings.push(t('warn.holiday'))
      if (financeStatus === 'error' || financeStatus === 'stale') warnings.push(t('warn.finance'))
      if (direct && spend !== null && spend !== undefined && spend.status === 'ready') {
        if (spend.skipped > 0) warnings.push(t('warn.inexact', { n: spend.skipped }))
        if (Array.isArray(spend.unknownModels) && spend.unknownModels.length > 0) {
          warnings.push(t('warn.unknownModel', { models: spend.unknownModels.join(', ') }))
        }
        if (Array.isArray(spend.degradedYears) && spend.degradedYears.length > 0) {
          warnings.push(t('warn.calendarYears', { years: spend.degradedYears.join(', ') }))
        }
      }

      const note = detached
        ? h('div', { key: 'detached', className: 'dpc-note' }, t('model.notDirect', { provider: selection.provider }))
        : unknownProvider
          ? h('div', { key: 'unknown-provider', className: 'dpc-note' }, t('model.unknownProvider'))
          : null

      const clockSection = detached
        ? null
        : h('div', { key: 'clock' }, [
          h('div', { key: 'count', className: 'dpc-count' }, [
            h('span', { key: 'value', className: 'dpc-count-value' }, durationText(t, snapshot.remainingMs)),
            h('span', { key: 'until', className: 'dpc-count-until' }, snapshot.phase === 'peak' ? t('state.untilOff') : t('state.untilPeak')),
          ]),
          Timeline(snapshot, locale),
          h('div', { key: 'next', className: 'dpc-next' }, nextLine),
        ])

      // The table is long and rarely needed at a glance: it folds away so the
      // balance and this session's spend stay above the fold.
      const priceSection = detached
        ? null
        : h('details', { key: 'prices', className: 'dpc-sect dpc-details' }, [
          h('summary', { key: 'title', className: 'dpc-sect-title dpc-summary' }, t('prices.title', { currency: pricing.currency })),
          ...pricing.models.map((model) => PriceBlock({ model, t })),
        ])

      const moneySection = h('div', { key: 'money', className: 'dpc-sect' }, [
        h('div', { key: 'title', className: 'dpc-sect-title' }, t('money.title')),
        h('div', { key: 'balance', className: 'dpc-row' }, [
          h('span', { key: 'k', className: 'dpc-row-key' }, t('money.balance')),
          h('span', { key: 'v', className: 'dpc-row-value' }, balanceText),
        ]),
        spendText === null
          ? null
          : h('div', { key: 'session', className: 'dpc-row' }, [
            h('span', { key: 'k', className: 'dpc-row-key' }, t('money.sessionIn', { currency: pricing.currency })),
            h('span', { key: 'v', className: 'dpc-row-value' }, spendText),
          ]),
      ])

      const warningsSection = warnings.length === 0
        ? null
        : h('div', { key: 'warnings', className: 'dpc-sect' },
          warnings.map((warning, index) => h('div', { key: `fw-${index}`, className: 'dpc-warn' }, warning)))

      const asOf = finance && typeof finance.fetchedAt === 'string'
        ? t('money.asOf', { time: clock(Date.parse(finance.fetchedAt)) })
        : null

      return h('div', {
        ref: props.bindOutside,
        className: 'dpc-panel',
        id: props.id,
        tabIndex: -1,
        'data-phase': snapshot.phase,
        'data-detached': detached ? 'true' : 'false',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': t('panel.title'),
        style: props.style,
      }, [
        h('div', { key: 'head', className: 'dpc-head' }, [
          h('span', { key: 'dot', className: 'dpc-dot', 'aria-hidden': 'true' }),
          h('span', { key: 'state', className: 'dpc-state' }, snapshot.phase === 'peak' ? t('badge.peak') : t('badge.off')),
          h('span', { key: 'chip', className: 'dpc-chip' }, detached
            ? t('panel.notApplicable')
            : snapshot.phase === 'peak' ? t('panel.rate.peak') : t('panel.rate.off')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dpc-close',
            'aria-label': t('panel.close'),
            title: t('panel.close'),
            onClick: onClose,
          }, '×'),
        ]),
        note,
        clockSection,
        h('div', { key: 'rows', className: 'dpc-sect' }, rows),
        priceSection,
        moneySection,
        warningsSection,
        h('div', { key: 'foot', className: 'dpc-foot' }, [
          h('span', { key: 'updated' }, `${t('rows.updated')}: ${formatIsoDate(pricing.updated, locale)}`),
          h('a', {
            key: 'source',
            className: 'dpc-link',
            href: pricing.source,
            target: '_blank',
            rel: 'noreferrer',
          }, t('prices.source')),
          asOf === null ? null : h('span', { key: 'as-of' }, asOf),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dpc-refresh',
            onClick: onRefresh,
            disabled: financeStatus === 'loading' || financeStatus === 'refreshing',
          }, t('refresh')),
        ]),
      ])
    }

    /**
     * Place the panel under the badge, flipping above it and clamping to the
     * viewport so a collapsed composer near an edge still shows a whole panel.
     * @param {HTMLElement | null} anchor - the badge button.
     * @param {number} width - the panel width in pixels.
     * @returns {{ left: number, top: number }} the viewport position.
     */
    function placePanel(anchor, width) {
      const margin = 8
      const viewport = typeof window !== 'undefined' && window.visualViewport ? window.visualViewport : null
      const viewportWidth = viewport === null ? window.innerWidth : viewport.width
      const viewportHeight = viewport === null ? window.innerHeight : viewport.height
      const anchorHeight = 380
      const rect = anchor === null ? null : anchor.getBoundingClientRect()
      const anchorLeft = rect === null ? viewportWidth - width - margin : rect.right - width
      const left = Math.min(Math.max(margin, anchorLeft), Math.max(margin, viewportWidth - width - margin))
      let top = rect === null ? margin : rect.bottom + 6
      if (top + Math.min(anchorHeight, viewportHeight * 0.72) > viewportHeight - margin) {
        const above = rect === null ? margin : rect.top - Math.min(anchorHeight, viewportHeight * 0.72) - 6
        top = above > margin ? above : margin
      }
      return { left, top }
    }

    /**
     * The composer badge and its panel.
     * @param {object} props - slot props plus the injected services.
     * @returns {object | null} the badge element.
     */
    /**
     * The composer badge and its panel.
     *
     * A mouse click keeps the caret where it was; a keyboard activation moves
     * focus into the panel. Closing returns focus to whatever had it before the
     * panel opened, so typing can continue.
     *
     * @param {object} props - slot props plus the injected context.
     * @returns {object} the badge element.
     */
    function PeakClockBadge(props) {
      const { ctx } = props
      const localeSnapshot = useLocaleSnapshot(ctx)
      const language = activeLanguage(localeSnapshot)
      const locale = formattingLocale(language)
      const t = React.useMemo(() => ctx.locale.bind(NS), [ctx, localeSnapshot])
      const zone = useZone()
      const selection = useSelection(props, ctx)
      const direct = isDeepSeekRoute(selection.provider)
      const detached = selection.provider !== null && !direct
      const [open, setOpen] = React.useState(false)
      const [revision, setRevision] = React.useState(0)
      const now = useNow(1000)
      const year = Number(beijingDayKey(now).slice(0, 4))
      const calendar = useCalendar(year)
      const snapshot = React.useMemo(
        () => state(now, { calendar, zone, locale }),
        [now, calendar, zone, locale],
      )
      const sessionId = props.sessionId === undefined ? null : String(props.sessionId)
      // The balance is account-wide, so the panel reads it for every provider;
      // the spend row appears only for a route DeepSeek bills itself.
      const finance = useFinance({ sessionId, active: open, language, revision })

      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const focusPanelRef = React.useRef(false)
      const focusedRef = React.useRef(false)
      const returnFocusRef = React.useRef(null)
      const panelId = typeof React.useId === 'function' ? React.useId() : 'peak-clock-panel'
      const [position, setPosition] = React.useState(null)

      const close = React.useCallback((restoreFocus) => {
        setOpen(false)
        if (restoreFocus !== true) return
        const target = returnFocusRef.current
        if (target !== null && target !== undefined && target.isConnected && typeof target.focus === 'function') {
          target.focus({ preventScroll: true })
        } else if (buttonRef.current !== null) {
          buttonRef.current.focus()
        }
      }, [])

      const toggle = React.useCallback((event) => {
        returnFocusRef.current = document.activeElement
        focusPanelRef.current = event !== undefined && event.detail === 0
        focusedRef.current = false
        setOpen((value) => !value)
      }, [])

      // A pointer click outside closes without moving focus: the click already
      // put focus where the user pointed.
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current !== null && target instanceof Node && panelRef.current.contains(target)) return
          if (buttonRef.current !== null && target instanceof Node && buttonRef.current.contains(target)) return
          close(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
      }, [open, close])

      React.useEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const update = () => setPosition(placePanel(buttonRef.current, 340))
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [open])

      // Move focus in only for a keyboard opening, and pull the panel back into
      // the viewport after it grows: the price table arrives before the money.
      React.useLayoutEffect(() => {
        if (!open || position === null) return
        const node = panelRef.current
        if (node === null) return
        if (focusPanelRef.current && !focusedRef.current && typeof node.focus === 'function') {
          node.focus({ preventScroll: true })
          focusedRef.current = true
        }
        const rect = node.getBoundingClientRect()
        const maxTop = window.innerHeight - rect.height - 8
        setPosition((previous) => {
          if (previous === null) return previous
          const top = Math.min(previous.top, Math.max(8, maxTop))
          return top === previous.top ? previous : { ...previous, top }
        })
      }, [open, position, finance.data, locale])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          close(true)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, close])

      const stateLabel = snapshot.phase === 'peak' ? t('badge.peak') : t('badge.off')
      const compact = formatCompact(snapshot.remainingMs, t('daysShort'))
      const aria = detached
        ? t('badge.detached')
        : t('badge.aria', { state: stateLabel, time: compact })
      const title = detached ? t('badge.detached') : `${stateLabel} · ${durationText(t, snapshot.remainingMs)}`

      const refreshAll = React.useCallback(() => {
        setRevision((value) => value + 1)
        retryCalendar(year)
      }, [year])

      const panelNode = open && position !== null
        ? Panel({
          id: panelId,
          snapshot,
          t,
          locale,
          selection,
          finance: finance.data,
          financeStatus: finance.status,
          holidayDegraded: calendar.degraded,
          onRefresh: refreshAll,
          onClose: () => close(true),
          bindOutside: (node) => {
            panelRef.current = node
          },
          style: { left: position.left, top: position.top },
        })
        : null
      const portal = panelNode === null
        ? null
        : createPortal === null
          ? panelNode
          : createPortal(panelNode, document.body)

      return h('div', { className: 'dpc-root', 'data-phase': snapshot.phase, 'data-detached': detached ? 'true' : 'false' }, [
        h('style', { key: 'styles' }, CSS),
        h('button', {
          key: 'badge',
          ref: buttonRef,
          type: 'button',
          className: 'dpc-badge',
          title,
          'aria-label': aria,
          'aria-haspopup': 'dialog',
          'aria-controls': open ? panelId : undefined,
          'aria-expanded': open ? 'true' : 'false',
          onClick: toggle,
        }, [
          h('span', { key: 'dot', className: 'dpc-dot', 'aria-hidden': 'true' }),
          h('span', { key: 'label' }, detached ? '—' : stateLabel),
          detached
            ? null
            : h('span', { key: 'time', className: 'dpc-time' }, compact),
        ]),
        portal === null ? null : h(React.Fragment, { key: 'portal' }, portal),
      ])
    }

    // ─── Registration ───────────────────────────────────────────────────────

    const inject = ['slots', 'locale']

    /**
     * Bind the ambient services once so the badge reads them without context
     * lookups during render.
     * @param {object} ctx - the browser context.
     * @returns {Function} the slot component.
     */
    function withContext(ctx) {
      return function PeakClockSlot(props) {
        return h(PeakClockBadge, Object.assign({}, props, { ctx }))
      }
    }

    /** @param {object} ctx - browser Cordis context. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, ru: RU, zh: ZH }), 'peak-clock: dictionaries')
      ctx.effect(() => () => {
        calendarYears.clear()
        calendarListeners.clear()
      }, 'peak-clock: calendar cache')
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'plugin.peak-clock',
        order: 10,
        locale: NS,
      }, withContext(ctx)))
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.NS = NS
    module.exports.__internals = {
      dictionaries: { en: EN, ru: RU, zh: ZH },
      CSS,
      PeakClockBadge,
      Panel,
      Timeline,
      PriceBlock,
      placePanel,
      durationText,
      formatMoney,
      formatDate,
      useFinance,
      state,
      isPeakInstant,
      transitionsAround,
      timelineOf,
      scheduleWindows,
      priceFor,
      costOfUsage,
      modelOf,
      isDeepSeekRoute,
      MODELS,
      PRICING_UPDATED,
      PRICING_SOURCE,
      PRICING_CURRENCY,
      OFF_PEAK_MULTIPLIER,
      HOLIDAY_CALENDAR,
      snapshotYear,
      EMPTY_CALENDAR,
    }
    return module.exports
  },
})
