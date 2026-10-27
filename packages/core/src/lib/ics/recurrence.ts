// Recurrence plumbing (CONTRACTS §3): build an rrule.js RRuleSet from an
// IcsEvent, and the repeat-preset vocabulary shared by the event editors,
// mapping UI repeat state ↔ raw RRULE string. (Raw-string RRULE editing
// helpers live in lib/util/date.ts.)
//
// rrule.js lives in a single NAIVE datetime space: option dates are read via
// their UTC fields, and returned "UTC" dates are fake-UTC. wycal defines that
// space as the event's wall clock encoded as if UTC — `Date.UTC()` of the
// wall components for TZID events, the wall-as-UTC `IcsDate.utc` directly for
// floating events, and UTC midnights for all-day events. EXDATEs MUST go
// through the identical conversion or the set silently fails to exclude them
// (rrule applies the same tz rezone to both sides; research memo §1.9).
import { RRule, RRuleSet, type Options } from 'rrule'
import type { IcsDate, IcsEvent } from './types'
import { isValidTzid, utcToTzTime } from './tz'

/** Wall components of a UTC instant in `tzid`, as fake-UTC (rrule input space). */
function wallAsUtc(utcInstant: string, tzid: string): Date {
  const w = utcToTzTime(utcInstant, tzid) // 'YYYY-MM-DDTHH:MM:SS'
  return new Date(
    Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13), +w.slice(14, 16), +w.slice(17, 19)),
  )
}

/** IcsDate → naive rrule-space instant (fake-UTC wall of the event's form). */
function naiveOf(d: IcsDate): Date {
  if (d.date) {
    return new Date(Date.UTC(+d.date.slice(0, 4), +d.date.slice(5, 7) - 1, +d.date.slice(8, 10)))
  }
  if (d.tzid) return wallAsUtc(d.utc, d.tzid)
  // Floating: utc already carries wall-as-UTC. Plain UTC form: the instant
  // itself is the naive value — same code path, no conversion.
  return new Date(d.utc)
}

/**
 * RRULE + EXDATEs of `ev` as an rrule.js RRuleSet, everything in one naive
 * space. Returns null when the event does not recur. Throws when the raw
 * RRULE is unparseable (callers decide how to degrade).
 *
 * `dtstart` overrides the event's own start as the iteration anchor — used by
 * expand.ts's performance clamp (grid-preserving dtstart moved into the
 * window; CONTRACTS §3). It must already live in the same naive space.
 */
export function rruleFromEvent(ev: IcsEvent, dtstart?: Date): RRuleSet | null {
  if (!ev.rrule) return null
  const parsed = RRule.parseString(ev.rrule)
  const opts: Partial<Options> = { ...parsed, dtstart: dtstart ?? naiveOf(ev.start) }
  // A non-IANA TZID throws RangeError inside rrule's Intl rezone during
  // iteration; leave opts.tzid unset so the rule runs in wall-as-UTC space.
  if (ev.start.tzid && isValidTzid(ev.start.tzid)) opts.tzid = ev.start.tzid
  const set = new RRuleSet()
  set.rrule(new RRule(opts))
  for (const ex of ev.exdates) set.exdate(naiveOf(ex))
  return set
}

// ---------------------------------------------------------------------------
// Repeat presets (CONTRACTS §7): editor repeat state ↔ raw RRULE string.
// Moved out of the web EventEditor so there is ONE mapping; rules
// outside this vocabulary parse to 'custom' and must round-trip verbatim
// while the editor's repeat control is untouched (the dirty-flag contract).
// ---------------------------------------------------------------------------

/** Repeat vocabulary of the editors; 'custom' carries interval + BYDAY. */
export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'custom'

/** Editor repeat state (select value plus the custom reveal's controls). */
export interface RepeatState {
  preset: RepeatPreset
  interval: number
  byDay: string[]
}

/** BYDAY codes in rule order, Monday first. */
export const WEEKDAYS = [
  { code: 'MO', label: 'Mo', name: 'Monday' }, { code: 'TU', label: 'Tu', name: 'Tuesday' }, { code: 'WE', label: 'We', name: 'Wednesday' },
  { code: 'TH', label: 'Th', name: 'Thursday' }, { code: 'FR', label: 'Fr', name: 'Friday' },
  { code: 'SA', label: 'Sa', name: 'Saturday' }, { code: 'SU', label: 'Su', name: 'Sunday' },
] as const

/** Fixed-RRULE presets; weekly/custom are start-date dependent. */
const PRESET_RULES: Partial<Record<RepeatPreset, string>> = {
  daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY',
}

function rruleParam(rule: string, name: string): string | undefined {
  return new RegExp(`(?:^|;)${name}=([^;]+)`).exec(rule)?.[1]
}

/** BYDAY code of a local Date's weekday. */
export function weekdayCode(d: Date): string {
  return WEEKDAYS[(d.getDay() + 6) % 7].code
}

/** Best-effort inverse of buildRepeat; rules outside the preset vocabulary degrade to Custom. */
export function parseRepeat(rrule: string | undefined, start: Date): RepeatState {
  const fallback = [weekdayCode(start)]
  if (!rrule) return { preset: 'none', interval: 1, byDay: fallback }
  const freq = rruleParam(rrule, 'FREQ')
  const iv = Number(rruleParam(rrule, 'INTERVAL') ?? 1)
  const interval = Number.isFinite(iv) && iv >= 1 ? Math.floor(iv) : 1
  const rawDays = rruleParam(rrule, 'BYDAY')
  const dayList = rawDays !== undefined ? rawDays.split(',') : []
  // Only plain 'MO'–'SU' codes are representable; '2MO'-style prefixes are not.
  const days = dayList.filter((d) => WEEKDAYS.some((w) => w.code === d))
  // Clauses the presets cannot express force Custom so an untouched rule
  // round-trips verbatim instead of being silently rewritten.
  const extra =
    (rawDays !== undefined && days.length !== dayList.length) ||
    rruleParam(rrule, 'BYMONTHDAY') !== undefined ||
    rruleParam(rrule, 'BYMONTH') !== undefined ||
    rruleParam(rrule, 'BYSETPOS') !== undefined
  const simple = interval === 1 && !extra
  const isWeekdays = days.length === 5 && WEEKDAYS.slice(0, 5).every((w) => days.includes(w.code))
  if (freq === 'DAILY' && simple && rawDays === undefined) return { preset: 'daily', interval, byDay: fallback }
  if (freq === 'WEEKLY' && simple && isWeekdays) return { preset: 'weekdays', interval, byDay: days }
  if (freq === 'WEEKLY' && simple && days.length <= 1) return { preset: 'weekly', interval, byDay: days.length ? days : fallback }
  if (freq === 'MONTHLY' && simple) return { preset: 'monthly', interval, byDay: fallback }
  if (freq === 'YEARLY' && simple) return { preset: 'yearly', interval, byDay: fallback }
  return { preset: 'custom', interval, byDay: days.length ? days : fallback }
}

/** Preset + custom controls → raw RRULE value (undefined = no repetition). */
export function buildRepeat(state: RepeatState, start: Date): string | undefined {
  if (state.preset === 'none') return undefined
  if (state.preset === 'weekly') return `FREQ=WEEKLY;BYDAY=${weekdayCode(start)}`
  const preset = PRESET_RULES[state.preset]
  if (preset) return preset
  const days = WEEKDAYS.filter((w) => state.byDay.includes(w.code)).map((w) => w.code)
  const interval = Math.max(1, Math.floor(state.interval) || 1)
  return `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${days.length ? days.join(',') : weekdayCode(start)}`
}
