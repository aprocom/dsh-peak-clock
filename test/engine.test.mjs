import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DAY_MS,
  beijingDayKey,
  beijingMidnightMs,
  beijingParts,
  durationParts,
  formatClock,
  formatCompact,
  formatOffset,
  isPeakInstant,
  relativeDay,
  scheduleWindows,
  state,
  timelineOf,
  transitionsAround,
  zoneOffsetMs,
} from '../lib/engine.js'

const CALENDAR = JSON.parse(readFileSync(new URL('../lib/holidays.json', import.meta.url), 'utf8'))
const holidays = CALENDAR.years['2026'].holidays
const workdays = CALENDAR.years['2026'].workdays

const at = (iso) => Date.parse(iso)
const MOSCOW = 'Europe/Moscow'

test('Beijing parts follow UTC+8 with no daylight saving time', () => {
  assert.deepEqual(beijingParts(at('2026-11-16T13:37:00Z')), {
    year: 2026,
    month: 11,
    day: 16,
    weekday: 1,
    minuteOfDay: 21 * 60 + 37,
  })
  assert.equal(beijingDayKey(at('2026-11-16T15:59:00Z')), '2026-11-16')
  assert.equal(beijingDayKey(at('2026-11-16T16:01:00Z')), '2026-11-17')
  assert.equal(beijingMidnightMs('2026-11-16'), at('2026-11-15T16:00:00Z'))
})

test('peak windows are the published UTC minutes', () => {
  assert.equal(isPeakInstant(at('2026-11-16T00:59:59Z'), { holidays }).peak, false)
  assert.equal(isPeakInstant(at('2026-11-16T01:00:00Z'), { holidays }).peak, true)
  assert.equal(isPeakInstant(at('2026-11-16T03:59:59Z'), { holidays }).peak, true)
  assert.equal(isPeakInstant(at('2026-11-16T04:00:00Z'), { holidays }).peak, false)
  assert.equal(isPeakInstant(at('2026-11-16T06:00:00Z'), { holidays }).peak, true)
  assert.equal(isPeakInstant(at('2026-11-16T09:59:59Z'), { holidays }).peak, true)
  assert.equal(isPeakInstant(at('2026-11-16T10:00:00Z'), { holidays }).peak, false)
})

test('weekends are off-peak all day', () => {
  const decision = isPeakInstant(at('2026-11-21T02:00:00Z'), { holidays })
  assert.equal(decision.peak, false)
  assert.equal(decision.reason, 'weekend')
  assert.equal(decision.holidayKey, null)
})

test('a Chinese public holiday has no peak at all', () => {
  // 1 October 2026 is a Thursday inside National Day.
  const decision = isPeakInstant(at('2026-10-01T02:00:00Z'), { holidays })
  assert.equal(decision.peak, false)
  assert.equal(decision.reason, 'holiday')
  assert.equal(decision.holidayKey, 'national-day')
  assert.equal(isPeakInstant(at('2026-10-01T08:00:00Z'), { holidays }).peak, false)
  // 8 October 2026 is a Thursday after the holiday: peak is back.
  assert.equal(isPeakInstant(at('2026-10-08T02:00:00Z'), { holidays }).peak, true)
})

test('a make-up Saturday workday stays off-peak', () => {
  // 14 February 2026 is a Saturday the notices designate as a working day.
  const decision = isPeakInstant(at('2026-02-14T02:00:00Z'), { holidays, workdays })
  assert.equal(decision.peak, false)
  assert.equal(decision.reason, 'weekend')
  assert.equal(decision.workdayKey, 'spring-festival')
})

test('the next change skips the weekend instead of naming a window that never opens', () => {
  // Exactly on the closing boundary the off-peak window has just opened.
  const friday = transitionsAround(at('2026-11-20T10:00:00Z'), { holidays })
  assert.equal(friday.previous.phase, 'off')
  assert.equal(friday.previous.at, at('2026-11-20T10:00:00Z'))
  assert.equal(friday.next.phase, 'peak')
  assert.equal(friday.next.at, at('2026-11-23T01:00:00Z'))

  const fridayPeak = transitionsAround(at('2026-11-20T07:00:00Z'), { holidays })
  assert.equal(fridayPeak.previous.at, at('2026-11-20T06:00:00Z'))
  assert.equal(fridayPeak.previous.phase, 'peak')
  assert.equal(fridayPeak.next.at, at('2026-11-20T10:00:00Z'))

  const sunday = transitionsAround(at('2026-11-22T05:00:00Z'), { holidays })
  assert.equal(sunday.previous.at, at('2026-11-20T10:00:00Z'))
  assert.equal(sunday.next.at, at('2026-11-23T01:00:00Z'))
})

test('a holiday week collapses into one long off-peak stretch', () => {
  const early = transitionsAround(at('2026-10-01T02:00:00Z'), { holidays })
  assert.equal(early.previous.at, at('2026-09-30T10:00:00Z'))
  assert.equal(early.next.at, at('2026-10-08T01:00:00Z'))
})

test('state carries the window, the countdown and the reason', () => {
  const snapshot = state(at('2026-11-16T02:00:00Z'), { calendar: { holidays }, zone: MOSCOW, locale: 'ru-RU' })
  assert.equal(snapshot.phase, 'peak')
  assert.equal(snapshot.reason, 'weekday')
  assert.equal(snapshot.remainingMs, 2 * 60 * 60 * 1000)
  assert.equal(snapshot.windowStartMs, at('2026-11-16T01:00:00Z'))
  assert.equal(snapshot.windowEndMs, at('2026-11-16T04:00:00Z'))
  assert.equal(snapshot.progress, 1 / 3)
  assert.equal(snapshot.next.phase, 'off')
  assert.equal(snapshot.next.at, at('2026-11-16T04:00:00Z'))
  assert.equal(snapshot.beijingTime, '10:00')
  assert.equal(snapshot.offsetLabel, 'UTC+03:00')

  const off = state(at('2026-11-16T04:30:00Z'), { calendar: { holidays }, zone: MOSCOW, locale: 'ru-RU' })
  assert.equal(off.phase, 'off')
  assert.equal(off.next.at, at('2026-11-16T06:00:00Z'))
  assert.equal(off.remainingMs, 90 * 60 * 1000)
})

test('the published schedule is rendered in the viewer zone', () => {
  const beijing = scheduleWindows(at('2026-11-16T13:00:00Z'), 'Asia/Shanghai', 'zh-CN')
  assert.deepEqual(beijing.map((window) => [window.startText, window.endText]), [['09:00', '12:00'], ['14:00', '18:00']])

  const moscow = scheduleWindows(at('2026-11-16T13:00:00Z'), MOSCOW, 'ru-RU')
  assert.deepEqual(moscow.map((window) => [window.startText, window.endText]), [['04:00', '07:00'], ['09:00', '13:00']])
})

test('the local-day timeline places the Moscow windows and the now marker', () => {
  const timeline = timelineOf(at('2026-11-16T13:00:00Z'), MOSCOW, { holidays })
  assert.equal(timeline.dayStartMs, at('2026-11-15T21:00:00Z'))
  assert.equal(timeline.segments.length, 2)
  const [first, second] = timeline.segments
  assert.ok(Math.abs(first.from - 4 / 24) < 0.005, `first.from ${first.from}`)
  assert.ok(Math.abs(first.to - 7 / 24) < 0.005, `first.to ${first.to}`)
  assert.ok(Math.abs(second.from - 9 / 24) < 0.005, `second.from ${second.from}`)
  assert.ok(Math.abs(second.to - 13 / 24) < 0.005, `second.to ${second.to}`)
  assert.ok(Math.abs(timeline.nowFraction - 16 / 24) < 0.005, `nowFraction ${timeline.nowFraction}`)
})

test('the timeline drops a peak stretch that the holiday removes', () => {
  const timeline = timelineOf(at('2026-10-01T02:00:00Z'), 'Asia/Shanghai', { holidays })
  assert.deepEqual(timeline.segments, [])
  assert.equal(timeline.dayStartMs, at('2026-09-30T16:00:00Z'))
})

test('a 25-hour local day still renders both windows', () => {
  // 1 November 2026: Europe/Moscow does not shift, so use a zone that does.
  const timeline = timelineOf(at('2026-11-01T12:00:00Z'), 'America/Los_Angeles', { holidays })
  const span = (timeline.segments.at(-1).to) - timeline.segments[0].from
  assert.ok(span > 0 && span <= 1)
  assert.ok(timeline.nowFraction >= 0 && timeline.nowFraction <= 1)
  assert.ok(span > 0.2)
})

test('timezone offsets and clock strings are correct', () => {
  assert.equal(zoneOffsetMs(at('2026-11-16T12:00:00Z'), MOSCOW), 3 * 60 * 60 * 1000)
  assert.equal(zoneOffsetMs(at('2026-07-16T12:00:00Z'), 'America/New_York'), -4 * 60 * 60 * 1000)
  assert.equal(formatOffset(at('2026-11-16T12:00:00Z'), 'Asia/Kolkata'), 'UTC+05:30')
  assert.equal(formatClock(at('2026-11-16T02:00:00Z'), MOSCOW, 'ru-RU'), '05:00')
})

test('durations split without rounding a minute up', () => {
  assert.deepEqual(durationParts(2 * 3600_000 + 18 * 60_000 + 40_000), {
    days: 0,
    hours: 2,
    minutes: 18,
    seconds: 40,
    underMinute: false,
  })
  assert.equal(durationParts(59_999).underMinute, true)
  assert.deepEqual(durationParts(2 * 86400_000 + 15 * 3600_000), {
    days: 2,
    hours: 15,
    minutes: 0,
    seconds: 0,
    underMinute: false,
  })
  assert.equal(formatCompact(2 * 3600_000 + 18 * 60_000, 'м', 'д'), '2:18')
  assert.equal(formatCompact(45 * 60_000, 'м', 'д'), '45м')
  assert.equal(formatCompact(30_000, 'м', 'д'), '<1м')
  assert.equal(formatCompact(2 * 86400_000 + 3 * 3600_000, 'м', 'д'), '2д')
})

test('relative days compare local calendar days, not 24-hour spans', () => {
  const now = at('2026-11-16T21:30:00Z') // 17 Nov, 00:30 in Moscow
  assert.equal(relativeDay(at('2026-11-16T22:00:00Z'), now, MOSCOW), 'today')
  // 00:30 on 17 November in Moscow: 09:00 UTC is still the same local day.
  assert.equal(relativeDay(at('2026-11-17T09:00:00Z'), now, MOSCOW), 'today')
  assert.equal(relativeDay(at('2026-11-18T09:00:00Z'), now, MOSCOW), 'tomorrow')
  assert.equal(relativeDay(at('2026-11-20T09:00:00Z'), now, MOSCOW), 'later')
  assert.ok(DAY_MS === 86_400_000)
})
