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
export const PEAK_WINDOWS_UTC = [
  [60, 240],
  [360, 600],
]

/** Beijing is UTC+8 with no daylight saving time. */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export const MINUTE_MS = 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

/** The timezone the pricing policy itself is written in. */
export const POLICY_ZONE = 'Asia/Shanghai'

/** Sampling step of the local-day timeline. */
export const TIMELINE_STEP_MS = 5 * MINUTE_MS

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
export function pad2(value) {
  return String(value).padStart(2, '0')
}

/** @param {number} value - any number. @param {number} min - lower bound. @param {number} max - upper bound. @returns {number} the clamped value. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/**
 * Wall-clock parts of one instant in Beijing.
 * @param {number} ms - epoch milliseconds.
 * @returns {{ year: number, month: number, day: number, weekday: number, minuteOfDay: number }} Beijing calendar parts; `weekday` is 0 for Sunday.
 */
export function beijingParts(ms) {
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
export function beijingDayKey(ms) {
  const parts = beijingParts(ms)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/**
 * Minute of the UTC day.
 * @param {number} ms - epoch milliseconds.
 * @returns {number} 0..1439.
 */
export function utcMinuteOfDay(ms) {
  return Math.floor((((ms % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS)
}

/**
 * The instant of UTC midnight for a `YYYY-MM-DD` key. A published window
 * belongs to the UTC date that carries the same calendar number as the Beijing
 * policy date, and both windows lie between 00:00 and 16:00 UTC.
 * @param {string} dayKey - a date key.
 * @returns {number} epoch milliseconds of 00:00 UTC on that date.
 */
export function utcMidnightMs(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/**
 * The instant of Beijing midnight for a `YYYY-MM-DD` key.
 * @param {string} dayKey - a Beijing date key.
 * @returns {number} epoch milliseconds of 00:00 Beijing on that date.
 */
export function beijingMidnightMs(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS
}

/**
 * The holiday and adjusted-workday entries a calendar holds for one date.
 * @param {{ holidays?: Record<string, string>, workdays?: Record<string, string> } | undefined} calendar - a year calendar or any merge of them.
 * @param {string} dayKey - a Beijing date key.
 * @returns {{ holidayKey: string | null, workdayKey: string | null }} the keys naming that date, when the calendar has them.
 */
export function calendarLookup(calendar, dayKey) {
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
export function isPeakInstant(ms, calendar) {
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
export function transitionsAround(ms, calendar) {
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
export function zoneOffsetMs(ms, zone) {
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
export function localDayStartMs(ms, zone) {
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
export function formatClock(ms, zone, locale) {
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
export function formatOffset(ms, zone) {
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
export function scheduleWindows(ms, zone, locale) {
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
export function timelineOf(ms, zone, calendar) {
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
export function relativeDay(target, now, zone) {
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
export function state(ms, options) {
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
 * @returns {{ hours: number, minutes: number, seconds: number, underMinute: boolean }} the parts; minutes and seconds are remainder values.
 */
export function durationParts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    underMinute: total < 60,
  }
}

/**
 * Compact countdown for the badge: `2:18` above an hour, `18м` below.
 * @param {number} ms - a non-negative duration.
 * @param {string} minuteSuffix - the localized one-letter or short minute suffix.
 * @returns {string} the compact text.
 */
export function formatCompact(ms, minuteSuffix) {
  const parts = durationParts(ms)
  if (parts.hours > 0) return `${parts.hours}:${pad2(parts.minutes)}`
  if (parts.minutes > 0) return `${parts.minutes}${minuteSuffix}`
  return `<1${minuteSuffix}`
}

/**
 * One decimal place of a share, for widths and progress bars.
 * @param {number} value - a 0..1 share.
 * @returns {string} a percentage string.
 */
export function percent(value) {
  return `${(clamp(value, 0, 1) * 100).toFixed(2)}%`
}
