/**
 * Date/time helpers (CONTRACTS §2 `lib/util/date.ts`).
 *
 * Three concerns live here:
 * 1. UI formatting (fmtTime/fmtDate/… honoring the `hour12` + `firstDay` prefs).
 * 2. IcsDate construction/normalization used by the stores when they build
 *    VEVENT data (overrides, EXDATEs, series splits).
 * 3. Raw RRULE-string editing for the `updateEvent(…, 'future')` series-split
 *    simplification mandated by CONTRACTS §4/§5 (UNTIL on the old base, new
 *    series from the cut point).
 */
import type { IcsDate, IcsEvent } from '../ics/types'
import { utcToTzTime } from '../ics/tz'
import { rruleFromEvent } from '../ics/recurrence'

// ---------------------------------------------------------------------------
// IcsDate plumbing
// ---------------------------------------------------------------------------

/** Normalize any ISO-ish instant to `Date.toISOString()` form. */
export function canonicalInstant(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toISOString()
}

/**
 * The instant of an IcsDate in the RECURRENCE NAIVE space (all-day → UTC
 * midnight of its date, floating → wall-as-UTC) that rrule.js iterates in
 * (research §1.9). NOT a duplicate of `icsDateToDate` in `ics/types` — that
 * one is the canonical display/instant helper (all-day → LOCAL midnight,
 * floating → system zone) used by parse/serialize/expand; this naive twin
 * stays because stores/events.ts series-split math (UNTIL/COUNT via UTC
 * fields) must not shift with the system zone.
 */
export function icsDateToDate(d: IcsDate): Date {
  if (d.date) return new Date(`${d.date}T00:00:00.000Z`)
  return new Date(canonicalInstant(d.utc))
}

/** All-day IcsDate from a `YYYY-MM-DD` string (floating naive space). */
export function allDayIcsDate(date: string): IcsDate {
  return { utc: `${date}T00:00:00.000Z`, date, floating: true }
}

/** Parse a recurrence-id string (canonical form) back to an IcsDate. */
export function parseRecId(recId: string): IcsDate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(recId)) return allDayIcsDate(recId)
  let t = Date.parse(`${recId}Z`) // zone-less (floating) recId → wall-as-UTC
  if (Number.isNaN(t)) t = Date.parse(recId) // explicit offset/Z → parse as-is
  if (Number.isNaN(t)) {
    console.warn(`wycal: unparseable recurrence-id ${recId}`)
    return { utc: new Date(0).toISOString() }
  }
  return { utc: new Date(t).toISOString() }
}

/**
 * Copy the "shape" (tzid / floating / all-day flags) of a template IcsDate —
 * almost always a base event's DTSTART — onto a new instant. EXDATEs and
 * RECURRENCE-IDs must live in the same naive space as DTSTART for rrule.js to
 * match them exactly (research §1.9).
 */
export function mirrorIcsDate(template: IcsDate, utc: string): IcsDate {
  const instant = canonicalInstant(utc)
  return {
    utc: instant,
    tzid: template.tzid,
    floating: template.floating,
    date: template.date ? instant.slice(0, 10) : undefined,
  }
}

// ---------------------------------------------------------------------------
// UI formatting
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function df(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts)
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts)
    fmtCache.set(key, f)
  }
  return f
}

/** `14:00` / `2:00 PM` depending on the hour12 pref. */
export function fmtTime(d: Date, hour12: boolean): string {
  return df({ hour: 'numeric', minute: '2-digit', hour12 }).format(d)
}

/** Short date, e.g. `Oct 9`; opts add weekday and/or year. */
export function fmtDate(d: Date, opts: { weekday?: boolean; year?: boolean } = {}): string {
  return df({
    month: 'short',
    day: 'numeric',
    ...(opts.weekday ? { weekday: 'short' as const } : {}),
    ...(opts.year ? { year: 'numeric' as const } : {}),
  }).format(d)
}

/** Short weekday alone, e.g. `Thu` (grid headers, weekday strips). */
export function fmtWeekday(d: Date): string {
  return df({ weekday: 'short' }).format(d)
}

/**
 * Human range for an event, shared by the detail popover and search rows:
 * `Wed, Oct 9 · 14:00 – 15:30`, cross-day
 * `Wed, Oct 9 14:00 – Thu, Oct 10 09:00`, all-day `Wed, Oct 9` /
 * `Wed, Oct 9 – Fri, Oct 11`. ICS DTEND is exclusive, so the displayed
 * all-day end steps back one day.
 */
export function fmtEventRange(start: Date, end: Date | null | undefined, allDay: boolean, hour12: boolean): string {
  if (allDay) {
    // ICS DTEND is exclusive: the displayed last day is `end - 1d`, and the
    // range test must run on THAT day. Testing the raw DTEND instead makes
    // every ordinary one-day all-day event (DTEND = DTSTART + 1d) render as a
    // bogus self-range, `Wed, Oct 14 – Wed, Oct 14` (birthdays hit this).
    const last = end ? addDays(end, -1) : null
    if (last && dayKey(last) !== dayKey(start)) {
      return `${fmtDate(start, { weekday: true })} – ${fmtDate(last, { weekday: true })}`
    }
    return fmtDate(start, { weekday: true })
  }
  const crossDay = end != null && dayKey(end) !== dayKey(start)
  if (crossDay) {
    return `${fmtDate(start, { weekday: true })} ${fmtTime(start, hour12)} – ${fmtDate(end, { weekday: true })} ${fmtTime(end, hour12)}`
  }
  return end
    ? `${fmtDate(start, { weekday: true })} · ${fmtTime(start, hour12)} – ${fmtTime(end, hour12)}`
    : fmtDate(start, { weekday: true })
}

// ---------------------------------------------------------------------------
// Calendar math (pure Date; no date-fns dependency in this layer)
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD` of a Date. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Midnight (local) of the week containing d, honoring the firstDay pref. */
export function startOfWeek(d: Date, firstDay: 0 | 1): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  let diff = out.getDay() - firstDay
  if (diff < 0) diff += 7
  out.setDate(out.getDate() - diff)
  return out
}

/** New Date + n days (local-day arithmetic). */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

/** New Date + n minutes. */
export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000)
}

// ---------------------------------------------------------------------------
// RRULE string editing (series split support for events.ts)
// ---------------------------------------------------------------------------

function splitRrule(rrule: string): { prefix: string; params: string[] } {
  const trimmed = rrule.trim()
  const m = /^RRULE:/i.exec(trimmed)
  const prefix = m ? m[0] : ''
  const rest = m ? trimmed.slice(m[0].length) : trimmed
  return { prefix, params: rest.split(';').filter((p) => p.length > 0) }
}

function joinRrule(prefix: string, params: string[]): string {
  return `${prefix}${params.join(';')}`
}

function rruleParam(rrule: string, name: string): string | undefined {
  const { params } = splitRrule(rrule)
  return params.find((p) => p.toUpperCase().startsWith(`${name}=`))?.split('=')[1]
}

/** `YYYYMMDDTHHMMSSZ` (UTC) — RFC 5545 date-time form for UNTIL. */
function fmtIcsUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** `YYYYMMDD` — RFC 5545 DATE form. */
function fmtIcsDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

/**
 * Set UNTIL on a raw RRULE (dropping COUNT — RFC 5545 forbids both), ending
 * the rule strictly before the cut. `untilUtc` must already be "the instant
 * just before the cut" (caller subtracts 1s / 1 day per timed/all-day).
 */
export function setRruleUntil(rrule: string, untilUtc: Date, allDay: boolean): string {
  const { prefix, params } = splitRrule(rrule)
  const kept = params.filter((p) => !/^COUNT=/i.test(p) && !/^UNTIL=/i.test(p))
  const until = allDay ? `UNTIL=${fmtIcsDate(untilUtc)}` : `UNTIL=${fmtIcsUtc(untilUtc)}`
  return joinRrule(prefix, [...kept, until])
}

/** Strip UNTIL from a raw RRULE (keeps COUNT). */
export function rruleWithoutUntil(rrule: string): string {
  const { prefix, params } = splitRrule(rrule)
  return joinRrule(prefix, params.filter((p) => !/^UNTIL=/i.test(p)))
}

/** COUNT value of a raw RRULE, if present. */
export function rruleCount(rrule: string): number | undefined {
  const v = rruleParam(rrule, 'COUNT')
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? undefined : n
}

/** Replace (or append) a parameter such as COUNT on a raw RRULE. */
export function setRruleParam(rrule: string, name: string, value: string): string {
  const { prefix, params } = splitRrule(rrule)
  const kept = params.filter((p) => !p.toUpperCase().startsWith(`${name}=`))
  return joinRrule(prefix, [...kept, `${name}=${value}`])
}

/**
 * The cut instant mapped into the event's *naive* (fake-UTC) recurrence space:
 * tzid events use their wall clock, floating/all-day/UTC events pass through.
 * This is the space `rruleFromEvent`'s RRuleSet iterates in (research §1.9).
 */
function naiveOccurrenceDate(ev: IcsEvent, instant: IcsDate): Date {
  const tzid = ev.start.tzid
  if (!tzid) return icsDateToDate(instant)
  const wall = utcToTzTime(icsDateToDate(instant).toISOString(), tzid)
  const t = Date.parse(/[zZ+-]\d\d:?\d\d$/.test(wall) ? wall : `${wall}Z`)
  return Number.isNaN(t) ? icsDateToDate(instant) : new Date(t)
}

/**
 * Number of occurrences of `ev` strictly before `instant`, or null if it could
 * not be computed (no rule / expansion error). Used to adjust COUNT when
 * splitting a counted series.
 */
export function countOccurrencesBefore(ev: IcsEvent, instant: IcsDate): number | null {
  if (!ev.rrule) return null
  try {
    const set = rruleFromEvent(ev)
    if (!set) return null
    const cut = naiveOccurrenceDate(ev, instant)
    const all = set.between(new Date(Date.UTC(1900, 0, 1)), cut, true)
    return Math.max(0, all.length - 1) // inclusive of the cut itself
  } catch (err) {
    console.warn('wycal: could not count occurrences before cut', err)
    return null
  }
}
