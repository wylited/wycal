/**
 * Quick-add draft builders — the ONE interpretation → record mapping shared
 * by the web dialog (views/quickadd/QuickAddDialog.tsx) and the mobile sheet
 * (components/quickadd/QuickAddSheet.tsx). The builders carry the dialog's
 * exact §16 Q semantics: uid generation, DTSTART from when/due, DTEND from
 * durationMin or the 60m default, VALUE=DATE for all-day, floating wall time
 * for timed saves (floatingWallIso — a toIcsDateInput floating form reads
 * back shifted by the zone offset, the −8h bug), RRULE/LOCATION passthrough,
 * CATEGORIES from tags, PRIORITY on todos.
 *
 * The two `interpretationFrom*` adapters fold the dialog's other entry
 * points into an Interpretation so every create path funnels through the
 * same builders: the grammar line pass (parseQuickAddLine) and the
 * palette-forwarded fields mode. Pure module: no store imports.
 */
import type { IcsDate, IcsEvent, IcsTodo } from '../lib/ics/types'
import { floatingWallIso, toIcsDateInput } from '../lib/ics/types'
import { newUid } from '../lib/util/id'
import type { Interpretation } from './nl'
import type { ParsedQuickAddLine, QuickAddKind } from './quickAdd'

/** Timed events default to 60m when the line parsed no duration (§16 Q). */
export const DEFAULT_EVENT_MINUTES = 60

const DAY_MS = 86_400_000

/** Builder options: tests seed uid/now; production calls omit them. */
export interface DraftOpts {
  /** Pre-seeded UID (tests); generated via newUid() when omitted. */
  uid?: string
  /** Timed events without a parsed duration end after this (60, §16 Q). */
  defaultDurationMin?: number
  /** Wall-clock reference for now-relative planning (tests); default now. */
  now?: Date
}

/** Structured palette prefill: the dialog's fields mode builds the entry
 *  from these directly (no grammar re-parse). */
export interface QuickAddFields {
  summary: string
  kind: 'event' | 'todo'
  allDay?: boolean
  start?: Date // timed start (set iff !allDay && timed)
  durationMin?: number // event duration
  due?: Date // todo due (day precision)
  rrule?: string
  location?: string
  tags?: string[]
  priority?: number | null
}

/** Strictly-next half-hour boundary (mirrors stores/ui nextHalfHour:
 *  14:00:23 → 14:30, 14:30:00 → 15:00). */
export function nextHalfHour(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 30))
  return d
}

/** Event draft timing, shared by the builders and the live previews. */
export interface EventDraftPlan {
  start: Date
  end: Date
  allDay: boolean
}

/**
 * Event timing from an interpretation: an all-day line (explicit 'all day'
 * or a date-only base) → all-day on the parsed day (today when none); a
 * wall time → timed there, ending at durationMin or the default; a duration
 * without a wall time → timed at the next half-hour on the parsed day (a
 * duration implies a timed event, §16 Q); a bare line → timed now for the
 * default duration.
 */
export function planEventDraft(interp: Interpretation, opts: DraftOpts = {}): EventDraftPlan {
  const now = opts.now ?? new Date()
  if (interp.allDay) {
    const day = interp.due ?? now
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
    return { start, end: new Date(start.getTime() + DAY_MS), allDay: true }
  }
  if (interp.when !== undefined) {
    const start = interp.when
    const min = interp.durationMin ?? opts.defaultDurationMin ?? DEFAULT_EVENT_MINUTES
    return { start, end: new Date(start.getTime() + min * 60_000), allDay: false }
  }
  if (interp.durationMin !== undefined) {
    const nh = nextHalfHour(now)
    const day = interp.due
    const start =
      day === undefined
        ? nh
        : new Date(day.getFullYear(), day.getMonth(), day.getDate(), nh.getHours(), nh.getMinutes())
    return { start, end: new Date(start.getTime() + interp.durationMin * 60_000), allDay: false }
  }
  const start = now
  const min = opts.defaultDurationMin ?? DEFAULT_EVENT_MINUTES
  return { start, end: new Date(start.getTime() + min * 60_000), allDay: false }
}

/**
 * Dialog grammar pass → Interpretation. The event shape bakes the §16 Q
 * planning in: a timed token → when; a duration without a wall time →
 * when = next half-hour on the parsed day (today when none); anything else
 * → all-day on the parsed day (today when none). Todos keep the raw due —
 * the builder formats it from the timed flag.
 */
export function interpretationFromLine(
  p: ParsedQuickAddLine,
  kind: QuickAddKind,
  now: Date = new Date(),
): Interpretation {
  const due = p.dueOrStart?.date
  const timed = p.dueOrStart !== undefined && !p.dueOrStart.allDay
  if (kind === 'event' && !timed) {
    if (p.durationMinutes !== undefined) {
      const nh = nextHalfHour(now)
      const when =
        due === undefined
          ? nh
          : new Date(due.getFullYear(), due.getMonth(), due.getDate(), nh.getHours(), nh.getMinutes())
      return fromLine(p, kind, when, false)
    }
    return fromLine(p, kind, undefined, true)
  }
  return fromLine(p, kind, timed ? due : undefined, p.allDay)
}

function fromLine(p: ParsedQuickAddLine, kind: QuickAddKind, when: Date | undefined, allDay: boolean): Interpretation {
  return {
    kind,
    title: p.summary,
    when,
    due: p.dueOrStart?.date,
    allDay,
    durationMin: p.durationMinutes,
    priority: p.priority,
    tags: p.tags,
    confidence: 'low',
    chips: [],
    raw: '',
  }
}

/**
 * Palette-forwarded fields → Interpretation (submitFields semantics):
 * timed at start ?? now; all-day pinning local midnight of start ?? now
 * (planEvent idiom); a midnight-wall due reading as day precision; priority
 * validated to 1–9; rrule/location/tags passed through verbatim.
 */
export function interpretationFromFields(f: QuickAddFields, summary: string, now: Date = new Date()): Interpretation {
  // Fields-mode priority law: only 1–9 survive; anything else drops.
  const prio =
    f.priority !== null && f.priority !== undefined && f.priority >= 1 && f.priority <= 9
      ? (f.priority as IcsTodo['priority'])
      : undefined
  const base = {
    title: summary,
    durationMin: f.durationMin,
    rrule: f.rrule,
    location: f.location,
    priority: prio,
    tags: f.tags ?? [],
    confidence: 'low' as const,
    chips: [],
    raw: '',
  }
  if (f.kind === 'todo') {
    // Midnight wall → day-precision (all-day) due; a carried time stays
    // timed (same law as §14a's due inputs).
    const dueTimed = f.due !== undefined && !(f.due.getHours() === 0 && f.due.getMinutes() === 0)
    return { ...base, kind: 'todo', when: dueTimed ? f.due : undefined, due: f.due, allDay: f.due !== undefined && !dueTimed }
  }
  if (f.allDay === true) {
    return { ...base, kind: 'event', when: undefined, due: f.start, allDay: true }
  }
  return { ...base, kind: 'event', when: f.start ?? now, due: f.start, allDay: false }
}

/** Parsed due → IcsDate: all-day → VALUE=DATE form; timed → floating wall
 *  time (the exact form TasksView's quick-add writes). */
function todoDueFromInterpretation(interp: Interpretation): IcsDate | undefined {
  if (interp.due === undefined) return undefined
  if (interp.when !== undefined) return floatingWallIso(interp.due)
  const d = interp.due
  return toIcsDateInput(new Date(d.getFullYear(), d.getMonth(), d.getDate()), true)
}

/** The event a quick-add interpretation creates (DTSTART/DTEND in the
 *  dialog's exact forms). */
export function eventFromInterpretation(interp: Interpretation, opts: DraftOpts = {}): IcsEvent {
  const plan = planEventDraft(interp, opts)
  return {
    uid: opts.uid ?? newUid(),
    summary: interp.title,
    // Timed saves carry the local wall time (floatingWallIso), not the true
    // instant — a toIcsDateInput floating form reads back shifted by the
    // zone offset (the −8h bug).
    start: plan.allDay ? toIcsDateInput(plan.start, true) : floatingWallIso(plan.start),
    end: plan.allDay ? toIcsDateInput(plan.end, true) : floatingWallIso(plan.end),
    allDay: plan.allDay,
    rrule: interp.rrule,
    location: interp.location,
    categories: interp.tags,
    exdates: [],
    attendees: [],
    alarms: [],
  }
}

/** The todo a quick-add interpretation creates (status NEEDS-ACTION, due in
 *  the dialog's exact forms, PRIORITY passthrough). */
export function todoFromInterpretation(interp: Interpretation, opts: DraftOpts = {}): IcsTodo {
  return {
    uid: opts.uid ?? newUid(),
    summary: interp.title,
    status: 'NEEDS-ACTION',
    categories: interp.tags,
    priority: interp.priority,
    due: todoDueFromInterpretation(interp),
    exdates: [],
    alarms: [],
  }
}

const BYDAY_FULL: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
}

const FREQ_WORD: Record<string, string> = {
  DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year',
}

/** 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' → 'Every 2 weeks on Mon, Wed'. */
export function describeRecurrence(rrule: string): string {
  const parts: Record<string, string> = {}
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) parts[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  const freq = parts.FREQ ?? ''
  const noun = FREQ_WORD[freq] ?? freq.toLowerCase()
  const interval = Number(parts.INTERVAL ?? '1')
  const bits = interval > 1 ? `Every ${interval} ${noun}s` : noun === 'day' ? 'Every day' : `Every ${noun}`
  const byday = parts.BYDAY
  if (byday === 'MO,TU,WE,TH,FR') return `${bits} on weekdays`
  if (byday !== undefined) {
    return `${bits} on ${byday.split(',').map((d) => BYDAY_FULL[d] ?? d).join(', ')}`
  }
  return bits
}
