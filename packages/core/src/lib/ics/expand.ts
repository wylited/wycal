// Windowed recurrence expansion (CONTRACTS §3), following the empirically
// verified rrule.js fake-UTC recipe (research memo §1.9, rrule@2.8.1):
//
// - Inputs to rrule (dtstart, EXDATEs) are naive wall clocks encoded with
//   Date.UTC (see recurrence.ts) — NEVER local Date constructors.
// - rrule rezones every emitted occurrence with dateInTimeZone(): the
//   returned epoch's UTC fields carry the wall clock of the true instant in
//   the SYSTEM zone. The exact inverse decode is the system-local
//   constructor fed the returned date's UTC getters.
// - between() bounds are compared against those rezoned epochs, so the
//   window is built by rendering each range bound's system-local wall into
//   Date.UTC — the one place local getters are correct, because it mirrors
//   rrule's own output encoding.
// - A 2-day pad plus an exact half-open [start, end) filter on true instants
//   keeps DST skew (|system offset| + |tzid offset| < 2 days for every real
//   zone, extreme offsets being UTC+14/UTC−12) from ever truncating or
//   leaking the candidate list.
//
// Performance: rrule.js iterates a rule from dtstart toward the window, so a
// sub-daily rule with a distant dtstart walks months/years of candidates per
// query (FREQ=SECONDLY since January = >120 s freeze). Two guards keep that
// bounded without changing window results: (1) rules that walk a fixed
// period grid and do not count from dtstart (no COUNT/BYSETPOS) get dtstart
// clamped to a grid point just before the window — every occurrence inside
// the window is generated identically, only the dead space before it is
// skipped; (2) rules that cannot be clamped are budgeted by estimated
// occurrence count and degrade to a single occurrence when they would blow
// the budget (same fallback as unparseable RRULEs).
import { Frequency, type RRule, type RRuleSet } from 'rrule'
import type { IcsDate, IcsEvent } from './types'
import {
  icsDateToDate,
  localMidnightIso,
  pad2,
  recurrenceIdOf,
  sameOccurrenceKey,
  shiftIcsDate,
} from './types'
import { rruleFromEvent } from './recurrence'
import { isValidTzid } from './tz'

interface ExpandRange {
  start: string
  end: string
}

const DAY_MS = 86400000
const PAD_DAYS = 2
/** Estimated rrule candidates we will iterate for one window; rules that
 * would exceed it (e.g. FREQ=SECONDLY spam) degrade to a single occurrence
 * instead of freezing the UI for seconds. */
const OCCURRENCE_BUDGET = 20000

/** Range bound → the rezoned epoch space rrule compares between() against. */
function windowEpoch(instantIso: string): Date {
  const t = new Date(instantIso)
  return new Date(
    Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()),
  )
}

/** Rough occurrences/day at a frequency/interval (MONTHLY/YEARLY ≈ 1/30·i). */
function perDay(freq: Frequency, interval: number): number {
  switch (freq) {
    case Frequency.SECONDLY:
      return 86400 / interval
    case Frequency.MINUTELY:
      return 1440 / interval
    case Frequency.HOURLY:
      return 24 / interval
    case Frequency.DAILY:
      return 1 / interval
    case Frequency.WEEKLY:
      return 1 / (7 * interval)
    default:
      return 1 / (30 * interval)
  }
}

/**
 * Grid-preserving dtstart for windowed iteration: a point the rule's own
 * walk visits (same wall time; whole periods from the real dtstart) at or
 * just before the window's padded lower bound, or null when clamping buys
 * nothing. between() compares *rezoned* epochs, whose naive walls can sit
 * |system offset| + |tzid offset| < 2 days away from the bound, so every
 * clamp target keeps a 2-day back-off. rrule.js walks a fixed period grid
 * (counterDate.add steps by INTERVAL unconditionally) for every frequency,
 * which keeps the candidate sequence inside the window identical; the
 * derived BY* defaults rrule fills from dtstart (WEEKLY weekday, MONTHLY
 * monthday, YEARLY month+monthday) are preserved by keeping the same wall
 * fields. Only MONTHLY/YEARLY targets whose month lacks dtstart's day
 * back off one more grid step.
 */
function clampedDtstart(rule: RRule, loEpoch: number): Date | null {
  const o = rule.origOptions
  const freq = o.freq
  if (freq === undefined) return null
  const interval = o.interval ?? 1
  if (!Number.isFinite(interval) || interval < 1) return null
  const dt = rule.options.dtstart.getTime()
  if (loEpoch <= dt) return null
  const target = loEpoch - 2 * DAY_MS // rezone slack, see above
  const dtDate = new Date(dt)
  const step = (period: number): Date | null => {
    const k = Math.ceil((target - dt) / period)
    return k <= 0 ? null : new Date(dt + k * period)
  }
  switch (freq) {
    case Frequency.SECONDLY:
      return step(interval * 1000)
    case Frequency.MINUTELY:
      return step(interval * 60000)
    case Frequency.HOURLY:
      return step(interval * 3600000)
    case Frequency.DAILY:
      return step(interval * DAY_MS)
    case Frequency.WEEKLY: {
      // Whole grid weeks later (same weekday/time), landing in a week that
      // ends before the padded-and-slacked bound so every in-window weekday
      // of the surrounding grid weeks is still generated.
      const weekStart = dt - ((dtDate.getUTCDay() - (rule.options.wkst ?? 0) + 7) % 7) * DAY_MS
      const period = interval * 7 * DAY_MS
      const k = Math.floor((target - 7 * DAY_MS - weekStart) / period)
      return k <= 0 ? null : new Date(dt + k * period)
    }
    case Frequency.MONTHLY: {
      // A grid month strictly before the (slack-adjusted) target's month:
      // later months' candidates are then all after the clamped dtstart.
      const loDate = new Date(target)
      const monthsBetween =
        (loDate.getUTCFullYear() - dtDate.getUTCFullYear()) * 12 + (loDate.getUTCMonth() - dtDate.getUTCMonth())
      let j = Math.floor((monthsBetween - 1) / interval)
      while (j > 0) {
        const total = dtDate.getUTCMonth() + j * interval
        const year = dtDate.getUTCFullYear() + Math.floor(total / 12)
        const month = total % 12
        const candidate = new Date(
          Date.UTC(
            year,
            month,
            dtDate.getUTCDate(),
            dtDate.getUTCHours(),
            dtDate.getUTCMinutes(),
            dtDate.getUTCSeconds(),
            dtDate.getUTCMilliseconds(),
          ),
        )
        if (candidate.getUTCMonth() === month && candidate.getUTCFullYear() === year) return candidate
        j -= interval // dtstart's day does not exist in that grid month
      }
      return null
    }
    case Frequency.YEARLY: {
      const yearsBetween = new Date(target).getUTCFullYear() - dtDate.getUTCFullYear()
      let j = Math.floor((yearsBetween - 1) / interval)
      while (j > 0) {
        const candidate = new Date(
          Date.UTC(
            dtDate.getUTCFullYear() + j * interval,
            dtDate.getUTCMonth(),
            dtDate.getUTCDate(),
            dtDate.getUTCHours(),
            dtDate.getUTCMinutes(),
            dtDate.getUTCSeconds(),
            dtDate.getUTCMilliseconds(),
          ),
        )
        if (candidate.getUTCMonth() === dtDate.getUTCMonth()) return candidate
        j -= interval // e.g. Feb 29 in a non-leap grid year
      }
      return null
    }
  }
  return null
}

/** Inverse of rrule's rezone: system-local wall fields → true instant. */
function trueInstant(occ: Date): Date {
  return new Date(
    occ.getUTCFullYear(),
    occ.getUTCMonth(),
    occ.getUTCDate(),
    occ.getUTCHours(),
    occ.getUTCMinutes(),
    occ.getUTCSeconds(),
  )
}

/** Calendar date of a 'YYYY-MM-DD' string shifted by whole days. */
function addDaysIso(ds: string, days: number): string {
  const t = new Date(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10) + days))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** Occurrence start as an IcsDate in the base event's form class. */
function occurrenceStart(base: IcsEvent, occ: Date): IcsDate {
  if (base.start.date) {
    // All-day rules iterate UTC midnights; the calendar date is the answer.
    const ds = occ.toISOString().slice(0, 10)
    return { utc: localMidnightIso(ds), date: ds }
  }
  if (base.start.floating) return { utc: occ.toISOString(), floating: true }
  // Only IANA TZIDs went through rrule's rezone (recurrence.ts guards the
  // same way); invalid ones decode as the naive wall-as-UTC instant itself.
  const tzid = base.start.tzid && isValidTzid(base.start.tzid) ? base.start.tzid : undefined
  if (tzid) return { utc: trueInstant(occ).toISOString(), tzid }
  // Plain UTC rule: the naive space IS the true instant.
  return { utc: occ.toISOString() }
}

/** Occurrence end: same wall duration semantics as the base event. */
function occurrenceEnd(base: IcsEvent, occStart: IcsDate): IcsDate {
  if (base.start.date && occStart.date && base.end.date) {
    const spanDays = Math.round(
      (Date.UTC(+base.end.date.slice(0, 4), +base.end.date.slice(5, 7) - 1, +base.end.date.slice(8, 10)) -
        Date.UTC(+base.start.date.slice(0, 4), +base.start.date.slice(5, 7) - 1, +base.start.date.slice(8, 10))) /
        DAY_MS,
    )
    const ds = addDaysIso(occStart.date, spanDays)
    return { utc: localMidnightIso(ds), date: ds }
  }
  const durationMs = icsDateToDate(base.end).getTime() - icsDateToDate(base.start).getTime()
  return shiftIcsDate(occStart, durationMs)
}

/**
 * Concrete occurrences of `base` overlapping the half-open window
 * [range.start, range.end) — an occurrence counts when it starts before the
 * window ends and ends after it starts, so multi-day events that begin
 * before the window still appear. Overrides are keyed by recurrenceId (bare, or
 * 'uid@cal#recId' as held by the events store); a matching override replaces
 * the generated occurrence wholesale. Occurrences carry `recurrenceId` and a
 * `provenance` flag; the base event itself is never mutated.
 */
export function expandEvents(base: IcsEvent, overrides: Map<string, IcsEvent>, range: ExpandRange): IcsEvent[] {
  const rangeStart = new Date(range.start).getTime()
  const rangeEnd = new Date(range.end).getTime()
  // Interval overlap, not a start-only test: events that begin before the
  // window but end inside it (multi-day events) must be included. Events
  // without an end get a nominal 1-day span.
  const inRange = (start: IcsDate, end?: IcsDate): boolean => {
    if (icsDateToDate(start).getTime() >= rangeEnd) return false
    const endEffective = end ?? shiftIcsDate(start, DAY_MS)
    return icsDateToDate(endEffective).getTime() > rangeStart
  }

  const overrideFor = (recId: string): IcsEvent | undefined => {
    const exact = overrides.get(recId)
    if (exact) return exact
    for (const [key, candidate] of overrides) {
      const hash = key.lastIndexOf('#')
      if (hash === -1) {
        // Bare recId keys match through the same form-tolerant comparison
        // (DATE-TIME RECURRENCE-ID vs an all-day occurrence key).
        if (sameOccurrenceKey(key, recId)) return candidate
        continue
      }
      // Scoped keys are 'uid@cal#recId'; the uid segment must belong to this
      // series so another series/calendar sharing an occurrence instant
      // never cross-matches.
      if (!key.startsWith(`${base.uid}@`)) continue
      if (sameOccurrenceKey(key.slice(hash + 1), recId)) return candidate
    }
    return undefined
  }

  const single = (): IcsEvent[] =>
    inRange(base.start, base.end) ? [{ ...base, provenance: base.provenance ?? 'base' }] : []

  if (!base.rrule) {
    if (!inRange(base.start, base.end)) return []
    const override = overrideFor(recurrenceIdOf(base.start))
    if (override) {
      return [
        {
          ...override,
          recurrenceId: override.recurrenceId ?? recurrenceIdOf(base.start),
          provenance: 'override',
        },
      ]
    }
    return [{ ...base, provenance: base.provenance ?? 'base' }]
  }

  let set: RRuleSet | null = null
  try {
    set = rruleFromEvent(base)
  } catch (err) {
    console.warn(`[wycal/ics] unparseable RRULE for ${base.uid}; treating as single occurrence`, err)
    return single()
  }
  if (!set) return single()

  // rrule.js iterates from dtstart, so guard the walk before between():
  // COUNT/BYSETPOS (and the exotic non-grid walks below) must iterate from
  // the real dtstart and are bounded by estimate; everything else gets a
  // grid-preserving dtstart clamp into the window. MINUTELY with BYHOUR and
  // SECONDLY with BYHOUR/BYMINUTE carry single-hour steps between grid
  // points (rrule's addMinutes/addSeconds), so they cannot be clamped.
  const rule = set.rrules()[0]
  const o = rule.origOptions
  const interval = typeof o.interval === 'number' && o.interval >= 1 ? o.interval : 1
  const counted = typeof o.count === 'number' && o.count > 0
  const hasBysetpos = Array.isArray(o.bysetpos) && o.bysetpos.length > 0
  const byHour = Array.isArray(o.byhour) ? o.byhour.length > 0 : typeof o.byhour === 'number'
  const byMinute = Array.isArray(o.byminute) ? o.byminute.length > 0 : typeof o.byminute === 'number'
  const gridWalk =
    o.freq !== undefined &&
    !(
      (o.freq === Frequency.MINUTELY && byHour) ||
      (o.freq === Frequency.SECONDLY && (byHour || byMinute))
    )
  const loEpoch = windowEpoch(range.start).getTime() - PAD_DAYS * DAY_MS
  const hiEpoch = windowEpoch(range.end).getTime() + PAD_DAYS * DAY_MS
  const dtEpoch = rule.options.dtstart.getTime()
  const density = o.freq === undefined ? 1 / interval : perDay(o.freq, interval)
  // Grid walks are clamped to the window, so only the window itself is
  // budgeted (an hourly rule running since 2000 costs milliseconds once
  // clamped); everything else pays for dtstart→window end, capped by COUNT
  // (a counted rule never iterates past its count).
  const estimateSpan = counted || hasBysetpos || !gridWalk ? dtEpoch : Math.max(dtEpoch, loEpoch)
  const estimate = counted
    ? Math.min(o.count ?? 0, ((hiEpoch - estimateSpan) / DAY_MS) * density)
    : ((hiEpoch - estimateSpan) / DAY_MS) * density
  if (estimate > OCCURRENCE_BUDGET) {
    console.warn(
      `[wycal/ics] RRULE for ${base.uid} would expand to ~${Math.round(estimate)} occurrences in this window; treating as single occurrence`,
    )
    return single()
  }

  let iterate: RRuleSet = set
  if (!counted && !hasBysetpos && gridWalk) {
    const clamped = clampedDtstart(rule, loEpoch)
    if (clamped) iterate = rruleFromEvent(base, clamped) ?? set
  }

  const lo = new Date(loEpoch)
  const hi = new Date(hiEpoch)
  const out: IcsEvent[] = []
  for (const occ of iterate.between(lo, hi, true)) {
    const occStart = occurrenceStart(base, occ)
    const recId = recurrenceIdOf(occStart)
    const override = overrideFor(recId)
    if (override) {
      if (!inRange(override.start, override.end)) continue
      out.push({ ...override, recurrenceId: override.recurrenceId ?? recId, provenance: 'override' })
      continue
    }
    const occEnd = occurrenceEnd(base, occStart)
    if (!inRange(occStart, occEnd)) continue
    out.push({
      ...base,
      start: occStart,
      end: occEnd,
      recurrenceId: recId,
      provenance: 'occurrence',
    })
  }
  return out
}
