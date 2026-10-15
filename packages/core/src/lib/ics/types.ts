// ICS data-layer types (CONTRACTS.md §3 + §11) + canonical IcsDate helpers
// shared by parse/serialize/recurrence/expand and the stores.
//
// IcsDate.utc is ALWAYS an ISO-8601 UTC string. For floating events (no TZID,
// no Z) it carries the *wall time encoded as if UTC* with `floating: true`;
// for all-day events `date` is authoritative and utc points at local midnight.

export interface IcsDate {
  utc: string /* ISO UTC instant */
  tzid?: string
  floating?: boolean
  date?: string /* YYYY-MM-DD when all-day */
}

type IcsProvenance = 'base' | 'occurrence' | 'override'

export interface IcsEvent {
  uid: string
  recurrenceId?: string /* UTC ISO (seconds precision) or floating date */
  summary: string
  location?: string
  description?: string
  start: IcsDate
  end: IcsDate
  allDay: boolean
  rrule?: string /* raw RRULE value, e.g. FREQ=WEEKLY;BYDAY=MO */
  exdates: IcsDate[]
  organizer?: string
  attendees: string[]
  categories: string[] /* CATEGORIES comma list, values text-unescaped */
  alarms: { trigger: string }[]
  color?: string
  raw?: string /* original unfolded VEVENT text; X- props preserved here */
  sequence?: number
  provenance?: IcsProvenance
  /** Raw VTIMEZONE blocks for non-IANA TZIDs this event references; re-emitted on serialize. */
  timezones?: string[]
}

/**
 * VTODO (CONTRACTS.md §11). Dates use the same IcsDate forms as events;
 * `status` defaults to 'NEEDS-ACTION' on parse. SEQUENCE is not modeled —
 * serializeIcsTodo keeps it via the preserved `raw` component text.
 */
export interface IcsTodo {
  uid: string
  summary: string
  description?: string
  dtstart?: IcsDate
  due?: IcsDate
  status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED'
  completed?: IcsDate
  percentComplete?: number
  priority?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  categories: string[] /* CATEGORIES comma list, values text-unescaped */
  relatedTo?: string /* parent todo uid */
  color?: string
  rrule?: string
  exdates: IcsDate[]
  alarms: { trigger: string }[]
  raw?: string /* original unfolded VTODO text; X- props preserved here */
  /** Raw VTIMEZONE blocks for non-IANA TZIDs this todo references; re-emitted on serialize. */
  timezones?: string[]
}

/** org `[#A]` parity: PRIORITY 1–3→A, 4–6→B, 7–9→C, else null. */
export function prioLetter(p?: number): 'A' | 'B' | 'C' | null {
  if (p === undefined || !Number.isInteger(p) || p < 1 || p > 9) return null
  return p <= 3 ? 'A' : p <= 6 ? 'B' : 'C'
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 'YYYY-MM-DDTHH:MM:SSZ' — seconds-precision UTC ISO used for recurrenceIds. */
function isoSec(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`
  )
}

/** Local calendar date of a Date as 'YYYY-MM-DD'. */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Local midnight of a 'YYYY-MM-DD' string. */
export function localMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function localMidnightIso(dateStr: string): string {
  return localMidnight(dateStr).toISOString()
}

/**
 * Canonical recurrenceId for an occurrence/override start: 'YYYY-MM-DD' for
 * all-day, wall 'YYYY-MM-DDTHH:MM:SS' for floating, seconds UTC ISO otherwise.
 * parse.ts (RECURRENCE-ID) and expand.ts (expanded occurrences) both use this
 * so override keys collide.
 */
export function recurrenceIdOf(d: IcsDate): string {
  if (d.date) return d.date
  if (d.floating) return d.utc.slice(0, 19)
  return isoSec(new Date(d.utc))
}

/**
 * Form-tolerant occurrence-key comparison: exact match, or — exactly when one
 * side is a bare 'YYYY-MM-DD' (all-day key) and the other a datetime — a
 * match on the date prefix. This lets a DATE-TIME RECURRENCE-ID written by
 * another client (e.g. `20260303T090000Z` → key '2026-03-03T09:00:00Z')
 * still collide with the '2026-03-03' key of an all-day series occurrence.
 *
 * Key derivation itself (`recurrenceIdOf`) cannot be tolerant without knowing
 * the base event's form, so matching call sites must compare through this
 * helper. expand.ts's `overrideFor` should use it in both lookups:
 *   - `const exact = overrides.get(recId)` → fall back to scanning
 *     `if (sameOccurrenceKey(key, recId)) return candidate` for bare keys
 *   - `key.slice(hash + 1) === recId` → `sameOccurrenceKey(key.slice(hash + 1), recId)`
 */
export function sameOccurrenceKey(a: string, b: string): boolean {
  if (a === b) return true
  const aIsDate = /^\d{4}-\d{2}-\d{2}$/.test(a)
  const bIsDate = /^\d{4}-\d{2}-\d{2}$/.test(b)
  // Only the mixed all-day/datetime pairing gets prefix tolerance; two
  // datetimes on the same day are different occurrences of a timed series.
  return aIsDate !== bIsDate && a.slice(0, 10) === b.slice(0, 10)
}

/**
 * Timed IcsDate carrying the local *wall* time (encoded as-if-UTC with
 * `floating: true`), so read-back (icsDateToDate) restores the same wall
 * time regardless of zone.
 *
 * LAW (CONTRACTS §34/§35): a floating IcsDate is always WALL-ENCODED —
 * Date.UTC of the local wall fields — never a true instant. This is the
 * single wall-encoding path; toIcsDateInput's floating branch routes
 * through it, so edits and drag-drops of floating originals cannot store
 * a true instant (which would read back shifted by the zone offset — the
 * −8h bug family).
 */
export function floatingWallIso(d: Date): IcsDate {
  const wall = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()))
  return { utc: wall.toISOString(), floating: true }
}

/**
 * Build an IcsDate from a UI Date (a true instant). `utcForm` keeps timed
 * inputs without a TZID in the UTC form (Z suffix) instead of floating —
 * EventEditor passes it so editing a UTC event does not silently convert it
 * to floating (which shifts the event by the zone offset on re-read).
 *
 * The floating branch (timed, no TZID, not utcForm) wall-encodes via
 * floatingWallIso per the floating = wall-encoded law — never a true
 * instant, or read-back shifts the event by the zone offset.
 */
export function toIcsDateInput(date: Date, allDay: boolean, tzid?: string, utcForm?: boolean): IcsDate {
  if (allDay) {
    const ds = localDateStr(date)
    return { utc: localMidnightIso(ds), date: ds }
  }
  if (tzid) return { utc: date.toISOString(), tzid }
  if (utcForm) return { utc: date.toISOString() }
  return floatingWallIso(date)
}

/**
 * IcsDate → true instant. All-day → local midnight of the calendar date.
 * Floating → the wall time interpreted in the system zone.
 *
 * Canonical IcsDate→Date helper (local-midnight semantics): the `icsDateToDate`
 * in `lib/util/date.ts` is a separate naive-space twin (wall-as-UTC), not a
 * duplicate — see its comment for why it exists.
 */
export function icsDateToDate(d: IcsDate): Date {
  if (d.date) return localMidnight(d.date)
  if (d.floating) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(d.utc)
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  }
  return new Date(d.utc)
}

/** Shift an IcsDate by a duration, preserving its form class (date/TZID/floating/UTC). */
export function shiftIcsDate(d: IcsDate, ms: number): IcsDate {
  if (d.date) {
    const ds = localDateStr(new Date(localMidnight(d.date).getTime() + ms))
    return { utc: localMidnightIso(ds), date: ds }
  }
  const nd = new Date(icsDateToDate(d).getTime() + ms)
  if (d.tzid) return { utc: nd.toISOString(), tzid: d.tzid }
  if (d.floating) {
    const wall = new Date(
      Date.UTC(nd.getFullYear(), nd.getMonth(), nd.getDate(), nd.getHours(), nd.getMinutes(), nd.getSeconds()),
    )
    return { utc: wall.toISOString(), floating: true }
  }
  return { utc: nd.toISOString() }
}

/** UID for newly created events. */
export function defaultUid(): string {
  const rnd =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `wycal-${rnd}@wycal.local`
}
