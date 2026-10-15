// Quick-add draft builder tests (CONTRACTS §16 Q): the shared
// interpretation → record mapping behind the web dialog and the mobile
// sheet. All assertions are system-date independent — expected dates are
// built through the same local-midnight conventions the parser uses (day
// offsets from today, weekday wrap), and IcsDate forms through the same
// lib/ics/types helpers the builders call.
import { describe, expect, it } from 'bun:test'
import { floatingWallIso, toIcsDateInput } from '../lib/ics/types'
import { interpret } from './nl'
import { parseQuickAddLine } from './quickAdd'
import {
  DEFAULT_EVENT_MINUTES,
  describeRecurrence,
  eventFromInterpretation,
  interpretationFromFields,
  interpretationFromLine,
  nextHalfHour,
  planEventDraft,
  todoFromInterpretation,
} from './draft'

const today = (): Date => {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}
/** Local midnight N days from today (negative allowed). */
const day = (n: number): Date => {
  const t = today()
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + n)
}
/** Same local day as `base` at wall time h:m. */
const at = (base: Date, h: number, m = 0): Date =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m)
/** Next occurrence of a JS getDay() number (today counts). */
const upcoming = (dow: number): Date => day((dow - today().getDay() + 7) % 7)

describe('eventFromInterpretation', () => {
  it('timed input → floating DTSTART at the parsed wall time, DTEND at the parsed duration', () => {
    const ev = eventFromInterpretation(interpret('Team sync fri 2pm 45m'), { uid: 'u1' })
    expect(ev.uid).toBe('u1')
    expect(ev.summary).toBe('Team sync')
    expect(ev.allDay).toBe(false)
    expect(ev.start).toEqual(floatingWallIso(at(upcoming(5), 14, 0)))
    expect(ev.end).toEqual(floatingWallIso(at(upcoming(5), 14, 45)))
    expect(ev.categories).toEqual([])
  })

  it('timed input without a duration ends at the 60m default', () => {
    const ev = eventFromInterpretation(interpret('Coffee with Dana tomorrow 3pm'))
    expect(ev.summary).toBe('Coffee with Dana')
    expect(ev.start).toEqual(floatingWallIso(at(day(1), 15, 0)))
    expect(ev.end).toEqual(floatingWallIso(at(day(1), 16, 0)))
  })

  it('all-day input → VALUE=DATE on the parsed day, end the following day', () => {
    const ev = eventFromInterpretation(interpret('event: board offsite tomorrow'), { uid: 'u2' })
    expect(ev.allDay).toBe(true)
    expect(ev.start).toEqual(toIcsDateInput(day(1), true))
    expect(ev.end).toEqual(toIcsDateInput(day(2), true))
  })

  it('recurring input passes the RRULE through and starts on the first BYDAY weekday', () => {
    const ev = eventFromInterpretation(interpret('gym every monday 7am'), { uid: 'u3' })
    expect(ev.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(ev.start).toEqual(floatingWallIso(at(upcoming(1), 7, 0)))
  })

  it('location lands on LOCATION', () => {
    const ev = eventFromInterpretation(interpret('dinner with ivy tomorrow 7pm at cafe lucas'))
    expect(ev.location).toBe('cafe lucas')
  })

  it('generates a @wycal uid when opts.uid is omitted', () => {
    const ev = eventFromInterpretation(interpret('sync fri 2pm'))
    expect(ev.uid.endsWith('@wycal')).toBe(true)
  })

  it('a duration without a wall time starts at the next half-hour (§16 Q)', () => {
    const now = new Date(2026, 9, 15, 14, 10)
    const p = parseQuickAddLine('standup 45m')
    const ev = eventFromInterpretation(interpretationFromLine(p, 'event', now), { now })
    expect(ev.start).toEqual(floatingWallIso(new Date(2026, 9, 15, 14, 30)))
    expect(ev.end).toEqual(floatingWallIso(new Date(2026, 9, 15, 15, 15)))
  })

  it('a bare event line is an all-day event today (dialog grammar semantics)', () => {
    const p = parseQuickAddLine('event: call mom')
    const interp = interpretationFromLine(p, 'event', at(today(), 10, 0))
    expect(interp.allDay).toBe(true)
    expect(interp.due).toBeUndefined()
    const ev = eventFromInterpretation(interp, { now: at(today(), 10, 0) })
    expect(ev.allDay).toBe(true)
    expect(ev.start).toEqual(toIcsDateInput(today(), true))
  })
})

describe('todoFromInterpretation', () => {
  it('due + priority: all-day due in VALUE=DATE form, PRIORITY passthrough', () => {
    const todo = todoFromInterpretation(interpret('todo: report due friday #A'), { uid: 't1' })
    expect(todo.uid).toBe('t1')
    expect(todo.summary).toBe('report')
    expect(todo.status).toBe('NEEDS-ACTION')
    expect(todo.priority).toBe(1)
    expect(todo.due).toEqual(toIcsDateInput(upcoming(5), true))
  })

  it('a timed due stays floating wall time', () => {
    const todo = todoFromInterpretation(interpret('todo: pay rent tomorrow 5pm'))
    expect(todo.due).toEqual(floatingWallIso(at(day(1), 17, 0)))
  })

  it('no parsed date → no due', () => {
    const todo = todoFromInterpretation(interpret('todo: call mom'))
    expect(todo.due).toBeUndefined()
  })
})

describe('categories from tags', () => {
  it('event tags become CATEGORIES', () => {
    const ev = eventFromInterpretation(interpret('sync fri 2pm +work'))
    expect(ev.categories).toEqual(['work'])
  })

  it('todo tags become CATEGORIES', () => {
    const todo = todoFromInterpretation(interpret('todo: milk +home +errands'))
    expect(todo.categories).toEqual(['home', 'errands'])
  })
})

describe('interpretationFromFields (palette fields mode)', () => {
  it('timed start + durationMin', () => {
    const interp = interpretationFromFields(
      { summary: 'lunch', kind: 'event', start: at(day(2), 12, 30), durationMin: 90, tags: ['team'] },
      'lunch',
    )
    const plan = planEventDraft(interp)
    expect(plan.allDay).toBe(false)
    expect(plan.start).toEqual(at(day(2), 12, 30))
    expect(plan.end).toEqual(at(day(2), 14, 0))
    expect(interp.tags).toEqual(['team'])
  })

  it('all-day pins local midnight of the start day', () => {
    const start = at(day(3), 13, 37)
    const interp = interpretationFromFields({ summary: 'conf', kind: 'event', allDay: true, start }, 'conf')
    const plan = planEventDraft(interp)
    expect(plan.allDay).toBe(true)
    expect(plan.start).toEqual(day(3))
    expect(plan.end).toEqual(day(4))
  })

  it('a bare event starts at the injected now for the default duration', () => {
    const now = new Date(2026, 9, 15, 9, 5)
    const interp = interpretationFromFields({ summary: 'x', kind: 'event' }, 'x', now)
    const plan = planEventDraft(interp, { now })
    expect(plan.start).toEqual(now)
    expect(plan.end.getTime() - plan.start.getTime()).toBe(DEFAULT_EVENT_MINUTES * 60_000)
  })

  it('midnight-wall due is day precision; a carried time stays timed', () => {
    const allday = interpretationFromFields({ summary: 'r', kind: 'todo', due: day(1) }, 'r')
    expect(todoFromInterpretation(allday).due).toEqual(toIcsDateInput(day(1), true))
    const timed = interpretationFromFields({ summary: 'r', kind: 'todo', due: at(day(1), 9, 30) }, 'r')
    expect(todoFromInterpretation(timed).due).toEqual(floatingWallIso(at(day(1), 9, 30)))
  })

  it('priority outside 1–9 drops; rrule and location pass through', () => {
    const bad = interpretationFromFields({ summary: 'r', kind: 'todo', priority: 0 }, 'r')
    expect(todoFromInterpretation(bad).priority).toBeUndefined()
    const good = interpretationFromFields(
      {
        summary: 'pt',
        kind: 'event',
        start: at(day(1), 8, 0),
        rrule: 'FREQ=DAILY',
        location: 'gym',
        priority: 4,
      },
      'pt',
    )
    const ev = eventFromInterpretation(good)
    expect(ev.rrule).toBe('FREQ=DAILY')
    expect(ev.location).toBe('gym')
  })
})

describe('nextHalfHour', () => {
  it('14:00:23 → 14:30, 14:30:00 → 15:00', () => {
    expect(nextHalfHour(new Date(2026, 9, 15, 14, 0, 23))).toEqual(new Date(2026, 9, 15, 14, 30))
    expect(nextHalfHour(new Date(2026, 9, 15, 14, 30, 0))).toEqual(new Date(2026, 9, 15, 15, 0))
  })
})

describe('describeRecurrence', () => {
  it("'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' → 'Every 2 weeks on Mon, Wed'", () => {
    expect(describeRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')).toBe('Every 2 weeks on Mon, Wed')
  })

  it('daily → Every day; the full weekday list folds to weekdays', () => {
    expect(describeRecurrence('FREQ=DAILY')).toBe('Every day')
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every week on weekdays')
  })
})
