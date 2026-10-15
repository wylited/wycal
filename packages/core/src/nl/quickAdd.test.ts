// Natural-language quick-add parser tests (CONTRACTS §15/§16 Q): decimal
// durations, long durations (up to 99h), time ranges, noon/midnight, bare
// 'at N' hours, bare ordinal dates, 'next week', 'all day', 'yesterday',
// capitalized weekdays, colon-less todo/task prefixes and '#tag'
// tokens — plus the pre-existing token behaviors they must not disturb. All
// assertions are system-date independent: expected dates are built through
// the same local-midnight conventions the implementation uses (day offsets
// from today, weekday wrap, this-or-next-month ordinals).
import { describe, expect, it } from 'bun:test'
import { describeDue, parseQuickAdd, parseQuickAddLine } from './quickAdd'
import type { ParsedQuickAddLine } from './quickAdd'

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
/** Next occurrence of a JS getDay() number (today counts), like weekdayDue. */
const upcoming = (dow: number): Date => day((dow - today().getDay() + 7) % 7)
/** The nth of this month, next month when already past — onOrdinalDay's law. */
const ordinalDate = (n: number): Date => {
  const t = today()
  const d = new Date(t.getFullYear(), t.getMonth(), n)
  if (d.getTime() < t.getTime()) d.setMonth(d.getMonth() + 1)
  return d
}
/** Monday of next week (Monday-first, like 'next mon'). */
const nextMonday = (): Date => day(7 - ((today().getDay() + 6) % 7))

const line = (s: string): ParsedQuickAddLine => parseQuickAddLine(s)

/** Chip spans must index the caller's input: slicing the original at each
 *  [start, end) reproduces the recorded text exactly. */
const chipSpans = (s: string): string[] =>
  line(s).chips.map((c) => s.slice(c.start, c.end))

describe('decimal durations (line pass only)', () => {
  it('1.5h → 90 minutes', () => {
    const r = line('standup 1.5h')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('standup')
    expect(r.durationMinutes).toBe(90)
  })
  it('2.5 hours → 150 minutes', () => {
    const r = line('gym 2.5 hours')
    expect(r.summary).toBe('gym')
    expect(r.durationMinutes).toBe(150)
  })
  it('1.5 hr → 90 minutes', () => {
    const r = line('call mom 1.5 hr')
    expect(r.summary).toBe('call mom')
    expect(r.durationMinutes).toBe(90)
  })
  it('whole-hour forms still parse (1h30, for 45 min)', () => {
    expect(line('sync 1h30').durationMinutes).toBe(90)
    expect(line('run for 45 min').durationMinutes).toBe(45)
    expect(line('wait 30m').durationMinutes).toBe(30)
  })
  it('todo pass keeps decimal durations as summary text', () => {
    const r = parseQuickAdd('standup 1.5h')
    expect(r.summary).toBe('standup 1.5h')
    expect(r.due).toBeUndefined()
  })
})

describe('time ranges', () => {
  it('3pm to 4pm → start 15:00, 60 min, no separator residue', () => {
    const r = line('sync 3pm to 4pm')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('sync')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 15).getTime())
    expect(r.dueOrStart?.allDay).toBe(false)
    expect(r.durationMinutes).toBe(60)
  })
  it('14:00-15:30 → 24h range, 90 min', () => {
    const r = line('deploy 14:00-15:30')
    expect(r.summary).toBe('deploy')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 14).getTime())
    expect(r.durationMinutes).toBe(90)
  })
  it('3-4pm → suffix-less start inherits pm', () => {
    const r = line('sync 3-4pm')
    expect(r.summary).toBe('sync')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 15).getTime())
    expect(r.durationMinutes).toBe(60)
  })
  it('10 to 11am → word separator, 60 min', () => {
    const r = line('standup 10 to 11am')
    expect(r.summary).toBe('standup')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 10).getTime())
    expect(r.durationMinutes).toBe(60)
  })
  it('start suffix honored and dash separator works (9am-5pm → 480 min)', () => {
    const r = line('shift 9am-5pm')
    expect(r.summary).toBe('shift')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 9).getTime())
    expect(r.durationMinutes).toBe(480)
  })
  it('en-dash separator works (3pm–4pm)', () => {
    const r = line('sync 3pm–4pm')
    expect(r.summary).toBe('sync')
    expect(r.durationMinutes).toBe(60)
  })
  it('range merges into a parsed date (fri 3-4pm)', () => {
    const r = line('sync fri 3-4pm')
    expect(r.dueOrStart?.date.getTime()).toBe(at(upcoming(5), 15).getTime())
    expect(r.durationMinutes).toBe(60)
  })
  it('suffix-less bare range stays text', () => {
    const r = line('items 5 - 6')
    expect(r.summary).toBe('items 5 - 6')
    expect(r.dueOrStart).toBeUndefined()
    expect(r.durationMinutes).toBeUndefined()
  })
  it('the whole range is one consumed chip in input coordinates', () => {
    expect(chipSpans('sync 3pm to 4pm')).toEqual(['3pm to 4pm'])
  })
})

describe('noon and midnight', () => {
  it('at noon → 12:00 timed', () => {
    const r = line('lunch at noon')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('lunch')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 12).getTime())
    expect(r.dueOrStart?.allDay).toBe(false)
    expect(r.dueOrStart?.text).toBe('at noon')
  })
  it('midnight → 00:00 timed', () => {
    const r = line('party at midnight')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 0).getTime())
    expect(r.dueOrStart?.allDay).toBe(false)
  })
  it('merges into a parsed date (fri noon)', () => {
    const r = line('standup fri noon')
    expect(r.dueOrStart?.date.getTime()).toBe(at(upcoming(5), 12).getTime())
  })
})

describe('bare hour after at', () => {
  it('meet at 5 → 17:00 (1–6 → pm)', () => {
    const r = line('meet at 5')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('meet')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 17).getTime())
    expect(r.dueOrStart?.text).toBe('at 5')
  })
  it('call at 8 → 08:00 (7–11 → am)', () => {
    const r = line('call at 8')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 8).getTime())
  })
  it('at 12 → 12:00 (12 → pm)', () => {
    const r = line('lunch at 12')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 12).getTime())
  })
  it('out-of-range hours stay text', () => {
    const r = line('x at 25')
    expect(r.summary).toBe('x at 25')
    expect(r.dueOrStart).toBeUndefined()
  })
  it('unit words win over the hour (5 minutes / 5 days)', () => {
    const minutes = line('hold at 5 minutes')
    expect(minutes.durationMinutes).toBe(5)
    expect(minutes.dueOrStart).toBeUndefined()
    const days = line('meet at 5 days')
    expect(days.summary).toBe('meet at 5 days')
    expect(days.dueOrStart).toBeUndefined()
  })
  it('suffixed times are untouched (at 5pm stays the 12h form)', () => {
    const r = line('jog at 5pm')
    expect(r.dueOrStart?.date.getTime()).toBe(at(today(), 17).getTime())
    expect(r.dueOrStart?.text).toBe('at 5pm')
  })
  it('merges into a parsed date (tomorrow at 9 → 09:00)', () => {
    const r = line('x tomorrow at 9')
    expect(r.dueOrStart?.date.getTime()).toBe(at(day(1), 9).getTime())
  })
})

describe('ordinal dates', () => {
  it('31st → the 31st of this month (all-day)', () => {
    const r = line('rent due 31st')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('rent due')
    expect(r.dueOrStart?.date.getTime()).toBe(ordinalDate(31).getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
  })
  it('1st already past → next month', () => {
    const r = line('review 1st')
    expect(r.dueOrStart?.date.getTime()).toBe(ordinalDate(1).getTime())
  })
  it('22nd stays this month when upcoming', () => {
    const r = line('sync 22nd')
    expect(r.dueOrStart?.date.getTime()).toBe(ordinalDate(22).getTime())
  })
  it('3rd and 15th resolve like any ordinal', () => {
    expect(line('pay 3rd').dueOrStart?.date.getTime()).toBe(ordinalDate(3).getTime())
    expect(line('off 15th').dueOrStart?.date.getTime()).toBe(ordinalDate(15).getTime())
  })
  it('impossible ordinals stay text', () => {
    const r = line('fake 45th')
    expect(r.summary).toBe('fake 45th')
    expect(r.dueOrStart).toBeUndefined()
  })
  it('month forms still win over the bare ordinal (oct 24th)', () => {
    const r = line('buy oct 24th')
    expect(r.dueOrStart?.date.getTime()).toBe(new Date(new Date().getFullYear(), 9, 24).getTime())
  })
})

describe('next week', () => {
  it('Monday of next week, all-day', () => {
    const r = line('plan next week')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('plan')
    expect(r.dueOrStart?.date.getTime()).toBe(nextMonday().getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
    expect(r.dueOrStart?.text).toBe('next week')
  })
  it("'next weekend' is not a date", () => {
    const r = line('next weekend trip')
    expect(r.summary).toBe('next weekend trip')
    expect(r.dueOrStart).toBeUndefined()
  })
})

describe('all day phrase', () => {
  it('day off friday all day → summary "day off", all-day Friday', () => {
    const r = line('day off friday all day')
    expect(r.summary).toBe('day off')
    expect(r.dueOrStart?.date.getTime()).toBe(upcoming(5).getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
  })
  it('all day tomorrow → tomorrow all-day', () => {
    const r = line('all day tomorrow')
    expect(r.dueOrStart?.date.getTime()).toBe(day(1).getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
  })
  it('overrides a parsed wall time (friday at 5 all day)', () => {
    const r = line('gym friday at 5 all day')
    expect(r.summary).toBe('gym')
    expect(r.dueOrStart?.date.getTime()).toBe(upcoming(5).getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
  })
  it('without a date it only consumes itself', () => {
    const r = line('x all day')
    expect(r.summary).toBe('x')
    expect(r.dueOrStart).toBeUndefined()
  })
})

describe('forced-kind prefixes', () => {
  it('todo: colon form still forces todo', () => {
    const r = line('todo: call mom')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('call mom')
  })
  it('todo without colon forces todo and strips the prefix', () => {
    const r = line('todo call mom')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('call mom')
  })
  it('task without colon forces todo', () => {
    const r = line('task file taxes')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('file taxes')
  })
  it("'todos' is not a prefix", () => {
    const r = line('todos to clear')
    expect(r.summary).toBe('todos to clear')
  })
  it('event prefixes keep the colon (event night stays plain text)', () => {
    const r = line('event night')
    expect(r.summary).toBe('event night')
    expect(r.kind).toBe('todo')
  })
  it('meeting: still forces event', () => {
    const r = line('meeting: standup')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('standup')
  })
})

describe('tags and priority', () => {
  it('#tag tokens become tags and leave the summary', () => {
    const r = line('errands #errands')
    expect(r.summary).toBe('errands')
    expect(r.tags).toEqual(['errands'])
    expect(chipSpans('errands #errands')).toEqual(['#errands'])
  })
  it('#tag works in the todo pass too', () => {
    const r = parseQuickAdd('x #home')
    expect(r.summary).toBe('x')
    expect(r.tags).toEqual(['home'])
  })
  it('#A stays priority, not a tag', () => {
    const r = line('x #A #home')
    expect(r.priority).toBe(1)
    expect(r.tags).toEqual(['home'])
    expect(r.summary).toBe('x')
  })
  it('+tag still works and both forms dedupe', () => {
    expect(line('x +home').tags).toEqual(['home'])
    expect(line('x #home +home').tags).toEqual(['home'])
  })
  it('#1d stays text (tag needs a leading letter)', () => {
    const r = line('x #1d')
    expect(r.summary).toBe('x #1d')
    expect(r.tags).toEqual([])
  })
})

describe('existing parses unchanged', () => {
  it('tmr → tomorrow', () => {
    const r = parseQuickAdd('x tmr')
    expect(r.summary).toBe('x')
    expect(r.due?.date.getTime()).toBe(day(1).getTime())
    expect(r.due?.allDay).toBe(true)
  })
  it('weekday + 12h time → timed event (team sync fri 2pm)', () => {
    const r = line('team sync fri 2pm')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('team sync')
    expect(r.dueOrStart?.date.getTime()).toBe(at(upcoming(5), 14).getTime())
    expect(r.allDay).toBe(false)
  })
  it('calendar dates and relative days still parse', () => {
    const buy = line('buy oct 20')
    expect(buy.dueOrStart?.date.getTime()).toBe(new Date(new Date().getFullYear(), 9, 20).getTime())
    expect(line('leave in 3 days').dueOrStart?.date.getTime()).toBe(day(3).getTime())
  })
  it('Milk tomorrow #A +home → todo with priority and tag', () => {
    const r = line('Milk tomorrow #A +home')
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('Milk')
    expect(r.priority).toBe(1)
    expect(r.tags).toEqual(['home'])
  })
  it('impossible times/dates stay in the summary', () => {
    expect(line('x 25pm').summary).toBe('x 25pm')
    expect(line('x 13/45').summary).toBe('x 13/45')
  })
  it('date-only line implies a todo, duration implies an event', () => {
    expect(line('x tomorrow').kind).toBe('todo')
    expect(line('x 30m').kind).toBe('event')
  })
})

describe('chips report caller-input spans', () => {
  it('every consumed token slices back to its own text', () => {
    const s = 'todo: mom tomorrow at 5pm #A +home all day'
    const r = line(s)
    expect(r.kind).toBe('todo')
    expect(r.summary).toBe('mom')
    for (const c of r.chips) expect(s.slice(c.start, c.end)).toBe(c.text)
    // 'tomorrow' sits at absolute offset 10 — the blanked 'todo: ' prefix
    // keeps every chip range valid against the full input.
    expect(r.chips.map((c) => [c.start, c.end, c.text])).toContainEqual([10, 18, 'tomorrow'])
  })
  it('describeDue renders the parsed hint', () => {
    expect(describeDue({ date: day(0), allDay: true })).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/)
    expect(describeDue({ date: at(today(), 17), allDay: false })).toMatch(/ · 5:00pm$/)
  })
})

describe('long durations (line pass only)', () => {
  it('for 25h → 1500 minutes, stripped from the title', () => {
    const r = line('Marathon tomorrow 8am for 25h')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('Marathon')
    expect(r.dueOrStart?.date.getTime()).toBe(at(day(1), 8).getTime())
    expect(r.durationMinutes).toBe(1500)
  })
  it("'for 25 hours' spelled out parses too", () => {
    const r = line('offsite for 25 hours')
    expect(r.summary).toBe('offsite')
    expect(r.durationMinutes).toBe(1500)
  })
  it('bare 25h parses', () => {
    expect(line('sync 25h').durationMinutes).toBe(1500)
  })
  it('hours run to 99; 100h and up stay text', () => {
    expect(line('x 99h').durationMinutes).toBe(5940)
    const over = line('x 100h')
    expect(over.summary).toBe('x 100h')
    expect(over.durationMinutes).toBeUndefined()
  })
  it('minutes, decimals and the todo pass are unchanged', () => {
    expect(line('x 90 min').durationMinutes).toBe(90)
    expect(line('x 1.5h').durationMinutes).toBe(90)
    expect(parseQuickAdd('x 25h').summary).toBe('x 25h')
  })
})

describe('yesterday', () => {
  it('yesterday → yesterday all-day, stripped', () => {
    const r = parseQuickAdd('Submit yesterday')
    expect(r.summary).toBe('Submit')
    expect(r.due?.date.getTime()).toBe(day(-1).getTime())
    expect(r.due?.allDay).toBe(true)
  })
  it('yesterday + time → timed event on yesterday', () => {
    const r = line('Blastpast yesterday 3pm')
    expect(r.kind).toBe('event')
    expect(r.summary).toBe('Blastpast')
    expect(r.dueOrStart?.date.getTime()).toBe(at(day(-1), 15).getTime())
  })
})

describe('capitalized weekdays', () => {
  it('Report Friday → the upcoming Friday, stripped', () => {
    const r = line('Report Friday')
    expect(r.summary).toBe('Report')
    expect(r.dueOrStart?.date.getTime()).toBe(upcoming(5).getTime())
    expect(r.dueOrStart?.allDay).toBe(true)
  })
  it("'Next Monday' capitalizes too", () => {
    const r = line('plan Next Monday')
    expect(r.summary).toBe('plan')
    expect(r.dueOrStart?.date.getTime()).toBe(nextMonday().getTime())
  })
})
