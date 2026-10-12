// Recurrence plumbing (CONTRACTS §3): build an rrule.js RRuleSet from an
// IcsEvent. (Raw-string RRULE editing helpers live in lib/util/date.ts.)
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
