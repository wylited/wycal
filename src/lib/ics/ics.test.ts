// Data-layer tests (CONTRACTS §8): ics parse/serialize round-trips, tz DST
// math, recurrence helpers, and windowed expansion. All assertions are
// system-timezone independent: fixed instants for UTC/TZID forms, and
// all-day windows built through the same localMidnightIso convention the
// implementation uses.
import { describe, expect, it } from 'bun:test'
import { parseIcs } from './parse'
import { serializeIcsEvent, serializeIcsTodo } from './serialize'
import { rruleFromEvent } from './recurrence'
import { expandEvents } from './expand'
import { tzTimeToUtc, utcToTzTime } from './tz'
import { defaultUid, icsDateToDate, localMidnightIso, prioLetter, sameOccurrenceKey, toIcsDateInput } from './types'
import type { IcsEvent, IcsTodo } from './types'

const mk = (patch: Partial<IcsEvent>): IcsEvent => ({
  uid: 'uid-1@example.test',
  summary: 'Event',
  start: { utc: '2026-03-02T10:00:00.000Z' },
  end: { utc: '2026-03-02T11:00:00.000Z' },
  allDay: false,
  exdates: [],
  attendees: [],
  categories: [],
  alarms: [],
  ...patch,
})

/** Fields the ics layer models — DTSTAMP and raw are intentionally excluded. */
const modeled = (ev: IcsEvent) => ({
  uid: ev.uid,
  summary: ev.summary,
  location: ev.location,
  description: ev.description,
  start: ev.start,
  end: ev.end,
  allDay: ev.allDay,
  rrule: ev.rrule,
  exdates: ev.exdates,
  organizer: ev.organizer,
  attendees: ev.attendees,
  categories: ev.categories,
  alarms: ev.alarms,
  sequence: ev.sequence,
  recurrenceId: ev.recurrenceId,
})

describe('parse/serialize round-trips', () => {
  it('timed UTC event', () => {
    const ev = mk({
      summary: 'Sync',
      location: 'Room 1',
      description: 'Bring laptops',
      organizer: 'mailto:organizer@example.test',
      attendees: ['mailto:a@example.test', 'mailto:b@example.test'],
      sequence: 2,
      alarms: [{ trigger: '-PT10M' }],
    })
    const { events } = parseIcs(serializeIcsEvent(ev))
    expect(events).toHaveLength(1)
    const back = events[0]
    expect(back.uid).toBe('uid-1@example.test')
    expect(back.summary).toBe('Sync')
    expect(back.start).toEqual({ utc: '2026-03-02T10:00:00.000Z' })
    expect(back.end).toEqual({ utc: '2026-03-02T11:00:00.000Z' })
    expect(back.allDay).toBe(false)
    expect(back.location).toBe('Room 1')
    expect(back.description).toBe('Bring laptops')
    expect(back.organizer).toBe('mailto:organizer@example.test')
    expect(back.attendees).toEqual(['mailto:a@example.test', 'mailto:b@example.test'])
    expect(back.sequence).toBe(2)
    expect(back.alarms).toEqual([{ trigger: '-PT10M' }])
  })

  it('all-day VALUE=DATE', () => {
    const ev = mk({
      allDay: true,
      summary: 'Offsite',
      start: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      end: { utc: localMidnightIso('2026-03-03'), date: '2026-03-03' },
      exdates: [{ utc: localMidnightIso('2026-03-04'), date: '2026-03-04' }],
    })
    const text = serializeIcsEvent(ev)
    expect(text).toContain('DTSTART;VALUE=DATE:20260302\r\n')
    expect(text).toContain('DTEND;VALUE=DATE:20260303\r\n')
    expect(text).toContain('EXDATE;VALUE=DATE:20260304\r\n')
    const { events } = parseIcs(text)
    expect(events[0].allDay).toBe(true)
    expect(events[0].start.date).toBe('2026-03-02')
    expect(events[0].end.date).toBe('2026-03-03')
    expect(events[0].exdates).toEqual([{ utc: localMidnightIso('2026-03-04'), date: '2026-03-04' }])
  })

  it('TZID with VTIMEZONE, RRULE, EXDATE, override, X- props', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//wycal//EN',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nEND:STANDARD',
      'BEGIN:DAYLIGHT\r\nDTSTART:19700308T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:ny@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=America/New_York:20260302T110000\r\nDTEND;TZID=America/New_York:20260302T120000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE;TZID=America/New_York:20260309T110000',
      'SUMMARY:NY weekly',
      'X-WYCAL-PAINT:stripe',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:ny@example.test',
      'DTSTAMP:20260101T000000Z',
      'RECURRENCE-ID:20260316T150000Z',
      'DTSTART:20260316T143000Z\r\nDTEND:20260316T153000Z',
      'SUMMARY:NY weekly (moved)',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events, timezones } = parseIcs(text)
    expect(timezones.get('America/New_York')).toContain('BEGIN:VTIMEZONE')
    expect(timezones.get('America/New_York')).toContain('TZID:America/New_York')

    const base = events[0]
    expect(base.summary).toBe('NY weekly')
    expect(base.start).toEqual({ utc: '2026-03-02T16:00:00.000Z', tzid: 'America/New_York' }) // EST
    expect(base.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(base.exdates).toEqual([{ utc: '2026-03-09T15:00:00.000Z', tzid: 'America/New_York' }]) // EDT
    expect(base.raw).toContain('X-WYCAL-PAINT:stripe')

    const override = events[1]
    expect(override.recurrenceId).toBe('2026-03-16T15:00:00Z')
    expect(override.provenance).toBe('override')
    expect(override.summary).toBe('NY weekly (moved)')
    expect(override.start).toEqual({ utc: '2026-03-16T14:30:00.000Z' })
  })

  it('escaped text: commas, semicolons, newlines', () => {
    const ev = mk({ summary: 'Sync, part 2; topics: a\nb', location: 'Back\\slash' })
    const text = serializeIcsEvent(ev)
    expect(text).toContain('SUMMARY:Sync\\, part 2\\; topics: a\\nb\r\n')
    expect(text).toContain('LOCATION:Back\\\\slash\r\n')
    const { events } = parseIcs(text)
    expect(events[0].summary).toBe('Sync, part 2; topics: a\nb')
    expect(events[0].location).toBe('Back\\slash')
  })

  it('folds long lines at 75 octets and unfolds exactly', () => {
    const long = 'x'.repeat(200) + ' 📅 ' + 'y'.repeat(100)
    const ev = mk({ description: long })
    const text = serializeIcsEvent(ev)
    for (const line of text.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    const { events } = parseIcs(text)
    expect(events[0].description).toBe(long)
  })

  it('serialize → parse stability on modeled fields', () => {
    const cases: IcsEvent[] = [
      mk({ summary: 'Timed', location: 'L', description: 'D', sequence: 7 }),
      mk({
        allDay: true,
        summary: 'All day, with comma',
        start: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
        end: { utc: localMidnightIso('2026-03-04'), date: '2026-03-04' },
        rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260601',
      }),
      mk({
        summary: 'Tzid',
        start: { utc: '2026-03-02T16:00:00.000Z', tzid: 'America/New_York' },
        end: { utc: '2026-03-02T17:00:00.000Z', tzid: 'America/New_York' },
      }),
      mk({
        summary: 'Floating',
        start: { utc: '2026-03-02T09:00:00.000Z', floating: true },
        end: { utc: '2026-03-02T10:00:00.000Z', floating: true },
      }),
    ]
    for (const ev of cases) {
      const { events } = parseIcs(serializeIcsEvent(ev))
      expect(modeled(events[0])).toEqual(modeled(ev))
    }
  })
})

describe('VTODO parse/serialize (CONTRACTS §11)', () => {
  const mkTodo = (patch: Partial<IcsTodo>): IcsTodo => ({
    uid: 'todo-1@example.test',
    summary: 'Task',
    status: 'NEEDS-ACTION',
    categories: [],
    exdates: [],
    alarms: [],
    ...patch,
  })

  /** Modeled todo fields — DTSTAMP and raw are intentionally excluded. */
  const modeledTodo = (t: IcsTodo) => ({
    uid: t.uid,
    summary: t.summary,
    description: t.description,
    dtstart: t.dtstart,
    due: t.due,
    status: t.status,
    completed: t.completed,
    percentComplete: t.percentComplete,
    priority: t.priority,
    categories: t.categories,
    relatedTo: t.relatedTo,
    color: t.color,
    rrule: t.rrule,
    exdates: t.exdates,
    alarms: t.alarms,
  })

  it('round-trips a fully populated VTODO', () => {
    const todo = mkTodo({
      summary: 'Write spec, review; ship',
      description: 'Step 1\nStep 2; back\\slash' + ' detail'.repeat(20),
      dtstart: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      due: { utc: '2026-03-04T17:00:00.000Z' },
      status: 'IN-PROCESS',
      completed: { utc: '2026-03-04T16:00:00.000Z' },
      percentComplete: 40,
      priority: 2,
      categories: ['home', 'errand, big', 'a;b'],
      relatedTo: 'parent-1@example.test',
      rrule: 'FREQ=DAILY;COUNT=5',
      exdates: [{ utc: localMidnightIso('2026-03-03'), date: '2026-03-03' }],
      alarms: [{ trigger: '-PT15M' }],
      color: '#f07178',
    })
    const text = serializeIcsTodo(todo)
    expect(text).toContain('BEGIN:VTODO\r\n')
    expect(text).toContain('END:VTODO\r\n')
    expect(text).toContain('DTSTART;VALUE=DATE:20260302\r\n')
    expect(text).toContain('DUE:20260304T170000Z\r\n')
    expect(text).toContain('COMPLETED:20260304T160000Z\r\n')
    expect(text).toContain('STATUS:IN-PROCESS\r\n')
    expect(text).toContain('PERCENT-COMPLETE:40\r\n')
    expect(text).toContain('PRIORITY:2\r\n')
    expect(text).toContain('RELATED-TO:parent-1@example.test\r\n')
    expect(text).toContain('X-WYCAL-COLOR:#f07178\r\n')
    expect(text).toContain('RRULE:FREQ=DAILY;COUNT=5\r\n')
    expect(text).toContain('EXDATE;VALUE=DATE:20260303\r\n')
    // Commas/semicolons inside categories are escaped, one comma-joined line.
    expect(text).toContain('CATEGORIES:home,errand\\, big,a\\;b\r\n')
    for (const line of text.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }

    const { events, todos } = parseIcs(text)
    expect(events).toHaveLength(0)
    expect(todos).toHaveLength(1)
    expect(modeledTodo(todos[0])).toEqual(modeledTodo(todo))
    expect(todos[0].raw!.startsWith('BEGIN:VTODO')).toBe(true)
    expect(todos[0].raw).toContain('X-WYCAL-COLOR:#f07178')
  })

  it('parses a wire VTODO (Radicale shape) and preserves SEQUENCE from raw', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Radicale//EN',
      'BEGIN:VTODO',
      'UID:task-1@example.test',
      'DTSTAMP:20260101T000000Z',
      'SEQUENCE:3',
      'SUMMARY:Buy milk',
      'STATUS:NEEDS-ACTION',
      'PRIORITY:5',
      'PERCENT-COMPLETE:0',
      'DUE;VALUE=DATE:20261012',
      'CATEGORIES:home,shopping',
      'RELATED-TO:parent-9@example.test',
      'X-WYCAL-COLOR:#a37acc',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { todos } = parseIcs(text)
    expect(todos).toHaveLength(1)
    const t = todos[0]
    expect(t.uid).toBe('task-1@example.test')
    expect(t.summary).toBe('Buy milk')
    expect(t.status).toBe('NEEDS-ACTION')
    expect(t.priority).toBe(5)
    expect(t.percentComplete).toBe(0)
    expect(t.due).toEqual({ utc: localMidnightIso('2026-10-12'), date: '2026-10-12' })
    expect(t.categories).toEqual(['home', 'shopping'])
    expect(t.relatedTo).toBe('parent-9@example.test')
    expect(t.color).toBe('#a37acc')
    expect(t.alarms).toEqual([{ trigger: '-PT15M' }])
    expect(t.raw).toContain('SEQUENCE:3')

    const out = serializeIcsTodo(t)
    expect(out).toContain('SEQUENCE:3\r\n') // preserved from the raw component
    expect(out).toContain('DUE;VALUE=DATE:20261012\r\n')
    expect(out).toContain('CATEGORIES:home,shopping\r\n')
    expect(out).toContain('X-WYCAL-COLOR:#a37acc\r\n')
    expect(parseIcs(out).todos[0].raw).toContain('SEQUENCE:3')
  })

  it('minimal VTODO defaults: NEEDS-ACTION, no percent/priority, empty lists', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:min-1@example.test',
      'DTSTAMP:20260101T000000Z',
      'SUMMARY:Minimal',
      'END:VTODO',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { todos } = parseIcs(text)
    expect(todos).toHaveLength(1)
    expect(todos[0].status).toBe('NEEDS-ACTION')
    expect(todos[0].percentComplete).toBeUndefined()
    expect(todos[0].priority).toBeUndefined()
    expect(todos[0].dtstart).toBeUndefined()
    expect(todos[0].due).toBeUndefined()
    expect(todos[0].completed).toBeUndefined()
    expect(todos[0].relatedTo).toBeUndefined()
    expect(todos[0].color).toBeUndefined()
    expect(todos[0].categories).toEqual([])
    expect(todos[0].exdates).toEqual([])
    expect(todos[0].alarms).toEqual([])
    // No raw → no SEQUENCE line on serialize.
    expect(serializeIcsTodo(todos[0])).not.toContain('SEQUENCE:')
  })

  it('mixed VEVENT/VTODO object routes to both arrays', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:ev-1@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T100000Z',
      'DTEND:20260302T110000Z',
      'SUMMARY:Event',
      'END:VEVENT',
      'BEGIN:VTODO',
      'UID:td-1@example.test',
      'DTSTAMP:20260101T000000Z',
      'SUMMARY:Task',
      'END:VTODO',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events, todos } = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('Event')
    expect(todos).toHaveLength(1)
    expect(todos[0].summary).toBe('Task')
  })
})

describe('categories + X-WYCAL-COLOR on events (CONTRACTS §11)', () => {
  it('CATEGORIES and color round-trip, raw keeps the component bounds', () => {
    const ev = mk({ categories: ['work', 'tag with, comma', 'semi;colon'], color: '#39bae6' })
    const text = serializeIcsEvent(ev)
    expect(text).toContain('CATEGORIES:work,tag with\\, comma,semi\\;colon\r\n')
    expect(text).toContain('X-WYCAL-COLOR:#39bae6\r\n')
    const { events } = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].categories).toEqual(['work', 'tag with, comma', 'semi;colon'])
    expect(events[0].color).toBe('#39bae6')
    expect(events[0].raw!.startsWith('BEGIN:VEVENT')).toBe(true)
    expect(events[0].raw).toContain('X-WYCAL-COLOR:#39bae6')
  })

  it('multiple CATEGORIES lines merge; malformed hex stays raw-only', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cats@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T100000Z',
      'DTEND:20260302T110000Z',
      'SUMMARY:Cats',
      'CATEGORIES:alpha',
      'CATEGORIES:beta\\, gamma',
      'X-WYCAL-COLOR:#12g',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events[0].categories).toEqual(['alpha', 'beta, gamma'])
    expect(events[0].color).toBeUndefined()
    expect(events[0].raw).toContain('X-WYCAL-COLOR:#12g')
  })
})

describe('prioLetter (org [#A] parity)', () => {
  it('maps PRIORITY bands 1–3/4–6/7–9 to A/B/C', () => {
    expect(prioLetter(1)).toBe('A')
    expect(prioLetter(3)).toBe('A')
    expect(prioLetter(4)).toBe('B')
    expect(prioLetter(6)).toBe('B')
    expect(prioLetter(7)).toBe('C')
    expect(prioLetter(9)).toBe('C')
  })

  it('returns null outside 1–9', () => {
    expect(prioLetter(undefined)).toBeNull()
    expect(prioLetter(0)).toBeNull()
    expect(prioLetter(10)).toBeNull()
  })
})

describe('timezone math (America/New_York, March DST)', () => {
  it('11:00 EST is 16:00Z and 11:00 EDT is 15:00Z', () => {
    expect(tzTimeToUtc('2026-03-06T11:00:00', 'America/New_York')).toBe('2026-03-06T16:00:00.000Z')
    expect(tzTimeToUtc('2026-03-09T11:00:00', 'America/New_York')).toBe('2026-03-09T15:00:00.000Z')
  })

  it('round-trips back through utcToTzTime', () => {
    expect(utcToTzTime('2026-03-06T16:00:00Z', 'America/New_York')).toBe('2026-03-06T11:00:00')
    expect(utcToTzTime('2026-03-09T15:00:00Z', 'America/New_York')).toBe('2026-03-09T11:00:00')
  })

  it('unknown TZID warns and degrades to UTC', () => {
    expect(tzTimeToUtc('2026-03-06T11:00:00', 'Mars/Olympus')).toBe('2026-03-06T11:00:00.000Z')
  })
})

describe('recurrence helpers', () => {
  it('rruleFromEvent: null without RRULE, set with EXDATEs applied', () => {
    expect(rruleFromEvent(mk({}))).toBeNull()
    const ev = mk({
      rrule: 'FREQ=DAILY;COUNT=3',
      start: { utc: '2026-03-02T09:00:00.000Z', floating: true },
      exdates: [{ utc: '2026-03-03T09:00:00.000Z', floating: true }],
    })
    const set = rruleFromEvent(ev)
    expect(set).not.toBeNull()
    expect(set!.all().map((d) => d.toISOString())).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-04T09:00:00.000Z',
    ])
  })

  it('rruleFromEvent: TZID events expand wall-clock-correctly across DST', () => {
    const ev = mk({
      rrule: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO',
      start: { utc: '2026-03-02T16:00:00.000Z', tzid: 'America/New_York' },
      end: { utc: '2026-03-02T17:00:00.000Z', tzid: 'America/New_York' },
    })
    const set = rruleFromEvent(ev)!
    const instants = set.all().map((d) =>
      new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).toISOString(),
    )
    // Wall clock preserved across the jump: EST → 16:00Z, EDT → 15:00Z.
    expect(instants).toEqual([
      '2026-03-02T16:00:00.000Z',
      '2026-03-09T15:00:00.000Z',
      '2026-03-16T15:00:00.000Z',
    ])
  })

})

describe('expandEvents', () => {
  it('daily all-day rule over a 7-day window (rule starts before window)', () => {
    const base = mk({
      allDay: true,
      summary: 'Standup holiday check',
      start: { utc: localMidnightIso('2026-03-01'), date: '2026-03-01' },
      end: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      rrule: 'FREQ=DAILY;COUNT=30',
    })
    const range = { start: localMidnightIso('2026-03-05'), end: localMidnightIso('2026-03-12') }
    const occ = expandEvents(base, new Map(), range)
    expect(occ.map((o) => o.start.date)).toEqual([
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
    ])
    expect(occ[0]).toMatchObject({ recurrenceId: '2026-03-05', provenance: 'occurrence', allDay: true })
    expect(occ[0].end.date).toBe('2026-03-06')
  })

  it('end is exclusive: occurrence starting exactly at range.end is excluded', () => {
    const base = mk({
      allDay: true,
      summary: 'Daily',
      start: { utc: localMidnightIso('2026-03-01'), date: '2026-03-01' },
      end: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      rrule: 'FREQ=DAILY;COUNT=30',
    })
    const occ = expandEvents(base, new Map(), { start: localMidnightIso('2026-03-05'), end: localMidnightIso('2026-03-08') })
    expect(occ.map((o) => o.start.date)).toEqual(['2026-03-05', '2026-03-06', '2026-03-07'])
  })

  it('EXDATE removes one occurrence', () => {
    const base = mk({
      allDay: true,
      summary: 'Daily',
      start: { utc: localMidnightIso('2026-03-01'), date: '2026-03-01' },
      end: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      rrule: 'FREQ=DAILY;COUNT=30',
      exdates: [{ utc: localMidnightIso('2026-03-06'), date: '2026-03-06' }],
    })
    const occ = expandEvents(base, new Map(), { start: localMidnightIso('2026-03-05'), end: localMidnightIso('2026-03-09') })
    expect(occ.map((o) => o.start.date)).toEqual(['2026-03-05', '2026-03-07', '2026-03-08'])
  })

  it('override replaces the occurrence it is keyed to', () => {
    const base = mk({
      allDay: true,
      summary: 'Daily',
      start: { utc: localMidnightIso('2026-03-01'), date: '2026-03-01' },
      end: { utc: localMidnightIso('2026-03-02'), date: '2026-03-02' },
      rrule: 'FREQ=DAILY;COUNT=30',
    })
    const moved = mk({
      uid: base.uid,
      allDay: true,
      summary: 'Moved',
      recurrenceId: '2026-03-08',
      provenance: 'override',
      start: { utc: localMidnightIso('2026-03-08'), date: '2026-03-08' },
      end: { utc: localMidnightIso('2026-03-10'), date: '2026-03-10' },
    })
    const occ = expandEvents(base, new Map([['2026-03-08', moved]]), {
      start: localMidnightIso('2026-03-05'),
      end: localMidnightIso('2026-03-12'),
    })
    const eighth = occ.find((o) => o.recurrenceId === '2026-03-08')
    expect(eighth).toMatchObject({ summary: 'Moved', provenance: 'override', allDay: true })
    expect(eighth!.end.date).toBe('2026-03-10')
    expect(occ.filter((o) => o.summary === 'Daily')).toHaveLength(6)
  })

  it('timed floating rule expands wall-clock occurrences (huge window)', () => {
    const base = mk({
      summary: 'Floater',
      rrule: 'FREQ=DAILY;COUNT=3',
      start: { utc: '2026-03-02T09:00:00.000Z', floating: true },
      end: { utc: '2026-03-02T09:30:00.000Z', floating: true },
    })
    const occ = expandEvents(base, new Map(), { start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' })
    expect(occ.map((o) => [o.start.utc, o.recurrenceId])).toEqual([
      ['2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00'],
      ['2026-03-03T09:00:00.000Z', '2026-03-03T09:00:00'],
      ['2026-03-04T09:00:00.000Z', '2026-03-04T09:00:00'],
    ])
    expect(occ[0].end.utc).toBe('2026-03-02T09:30:00.000Z')
    expect(occ.every((o) => o.provenance === 'occurrence')).toBe(true)
  })

  it('TZID weekly rule keeps true instants across the March DST jump', () => {
    const base = mk({
      summary: 'NY weekly',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      start: { utc: '2026-03-02T16:00:00.000Z', tzid: 'America/New_York' },
      end: { utc: '2026-03-02T17:00:00.000Z', tzid: 'America/New_York' },
      exdates: [{ utc: '2026-03-09T15:00:00.000Z', tzid: 'America/New_York' }],
    })
    const occ = expandEvents(base, new Map(), { start: '2026-03-01T00:00:00Z', end: '2026-03-20T00:00:00Z' })
    expect(occ.map((o) => [o.start.utc, o.recurrenceId])).toEqual([
      ['2026-03-02T16:00:00.000Z', '2026-03-02T16:00:00Z'],
      ['2026-03-16T15:00:00.000Z', '2026-03-16T15:00:00Z'],
    ])
    expect(occ[0].end.utc).toBe('2026-03-02T17:00:00.000Z')
    expect(occ[1].end.utc).toBe('2026-03-16T16:00:00.000Z')
    // Wall clock stays put across the jump (EST → EDT): true instants shift
    // 16:00Z → 15:00Z while 11:00 America/New_York is preserved.
    for (const o of occ) {
      expect(o.start.tzid).toBe('America/New_York')
      expect(utcToTzTime(o.start.utc, 'America/New_York')).toBe(`${o.recurrenceId!.slice(0, 10)}T11:00:00`)
    }
  })

  it('invalid TZID (Mars/Olympus) degrades to wall-as-UTC instead of crashing', () => {
    const { events } = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:mars@example.test',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Mars/Olympus:20260302T103000',
        'DTEND;TZID=Mars/Olympus:20260302T113000',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Mars standup',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    )
    const base = events[0]
    expect(base.start).toEqual({ utc: '2026-03-02T10:30:00.000Z', tzid: 'Mars/Olympus' })
    let occ: IcsEvent[] = []
    expect(() => {
      occ = expandEvents(base, new Map(), { start: '2026-03-01T00:00:00Z', end: '2026-03-10T00:00:00Z' })
    }).not.toThrow()
    expect(occ.map((o) => o.start.utc)).toEqual([
      '2026-03-02T10:30:00.000Z',
      '2026-03-03T10:30:00.000Z',
      '2026-03-04T10:30:00.000Z',
    ])
    // Degraded occurrences carry no TZID: the whole rule ran wall-as-UTC.
    expect(occ.every((o) => o.start.tzid === undefined)).toBe(true)
  })

  it('non-recurring event: returned inside window, dropped outside', () => {
    const base = mk({ summary: 'Once' })
    expect(expandEvents(base, new Map(), { start: '2026-03-02T00:00:00Z', end: '2026-03-03T00:00:00Z' })).toHaveLength(1)
    expect(expandEvents(base, new Map(), { start: '2026-03-03T00:00:00Z', end: '2026-03-04T00:00:00Z' })).toHaveLength(0)
  })

  it('multi-day event ending inside the window appears even though it starts before it', () => {
    // Fri 2026-03-06 → Sun 2026-03-08 (DTEND exclusive → Mon 2026-03-09).
    const base = mk({
      allDay: true,
      summary: 'Retreat',
      start: { utc: localMidnightIso('2026-03-06'), date: '2026-03-06' },
      end: { utc: localMidnightIso('2026-03-09'), date: '2026-03-09' },
    })
    // Window covering only Sunday: the Fri→Sun event must still be returned.
    const occ = expandEvents(base, new Map(), {
      start: localMidnightIso('2026-03-08'),
      end: localMidnightIso('2026-03-09'),
    })
    expect(occ).toHaveLength(1)
    expect(occ[0]).toMatchObject({ summary: 'Retreat', start: { date: '2026-03-06' }, end: { date: '2026-03-09' } })
    // The event is over once the window starts at/after its (exclusive) end.
    expect(expandEvents(base, new Map(), { start: localMidnightIso('2026-03-09'), end: localMidnightIso('2026-03-10') })).toHaveLength(0)
    // Same overlap rule for timed events: ends inside the window → included.
    const timed = mk({
      summary: 'Overnight',
      start: { utc: '2026-03-07T22:00:00.000Z' },
      end: { utc: '2026-03-08T10:00:00.000Z' },
    })
    expect(expandEvents(timed, new Map(), { start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z' })).toHaveLength(1)
  })

  it('override keys of the form uid@cal#recId are honored', () => {
    const base = mk({ summary: 'Once' })
    const ov = mk({ summary: 'Replaced', provenance: 'override' })
    const occ = expandEvents(base, new Map([['uid-1@example.test@http://cal#2026-03-02T10:00:00Z', ov]]), {
      start: '2026-03-02T00:00:00Z',
      end: '2026-03-03T00:00:00Z',
    })
    expect(occ).toHaveLength(1)
    expect(occ[0].summary).toBe('Replaced')
  })
})

describe('types helpers', () => {
  it('defaultUid is namespaced and unique', () => {
    expect(defaultUid()).toMatch(/^wycal-/)
    expect(defaultUid()).not.toBe(defaultUid())
  })

  it('toIcsDateInput / icsDateToDate round-trip', () => {
    const d = new Date('2026-03-02T10:00:00.000Z')
    expect(toIcsDateInput(d, false, 'Asia/Tokyo')).toEqual({ utc: d.toISOString(), tzid: 'Asia/Tokyo' })
    expect(icsDateToDate({ utc: d.toISOString(), tzid: 'Asia/Tokyo' })).toEqual(d)
    const flo = toIcsDateInput(d, false)
    expect(flo.floating).toBe(true)
    expect(icsDateToDate(flo)).toEqual(d)
    const allDay = toIcsDateInput(d, true)
    expect(allDay.date).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  })

  it('sameOccurrenceKey: DATE-TIME recId collides with the all-day base key', () => {
    expect(sameOccurrenceKey('2026-03-03', '2026-03-03T09:00:00Z')).toBe(true)
    expect(sameOccurrenceKey('2026-03-03T09:00:00Z', '2026-03-03')).toBe(true)
    expect(sameOccurrenceKey('2026-03-03', '2026-03-03')).toBe(true)
    // Two datetimes on the same day are distinct occurrences of a timed series.
    expect(sameOccurrenceKey('2026-03-03T09:00:00', '2026-03-03T10:00:00')).toBe(false)
    expect(sameOccurrenceKey('2026-03-03', '2026-03-04T09:00:00Z')).toBe(false)
  })

  it('toIcsDateInput keeps the UTC form when utcForm is set; default stays floating', () => {
    const d = new Date('2026-10-12T14:00:00.000Z')
    expect(toIcsDateInput(d, false, undefined, true)).toEqual({ utc: '2026-10-12T14:00:00.000Z' })
    expect(toIcsDateInput(d, false, undefined, true).floating).toBeUndefined()
    // Existing callers (quick-add, drag-move) keep the floating default.
    expect(toIcsDateInput(d, false, undefined)).toEqual({ utc: '2026-10-12T14:00:00.000Z', floating: true })
    // An edited UTC event serializes back with the Z suffix, not floating.
    const ev = mk({
      start: toIcsDateInput(d, false, undefined, true),
      end: toIcsDateInput(new Date(d.getTime() + 3_600_000), false, undefined, true),
    })
    expect(serializeIcsEvent(ev)).toContain('DTSTART:20261012T140000Z\r\n')
    expect(serializeIcsEvent(ev)).toContain('DTEND:20261012T150000Z\r\n')
  })
})

describe('edit round-trip preservation (raw merge + VTIMEZONE)', () => {
  it('unmodeled properties survive an edit-PUT; modeled ones stay authoritative', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:keep@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T100000Z',
      'DTEND:20260302T110000Z',
      'SUMMARY:Original',
      'STATUS:CANCELLED',
      'TRANSP:TRANSPARENT',
      'CLASS:PRIVATE',
      'URL:https://example.test/event',
      'RDATE:20260310T100000Z',
      'X-OTHER-CLIENT:flag=yes',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    const edited = { ...events[0], summary: 'Edited' }
    const out = serializeIcsEvent(edited)
    expect(out).toContain('STATUS:CANCELLED\r\n')
    expect(out).toContain('TRANSP:TRANSPARENT\r\n')
    expect(out).toContain('CLASS:PRIVATE\r\n')
    expect(out).toContain('URL:https://example.test/event\r\n')
    expect(out).toContain('RDATE:20260310T100000Z\r\n')
    expect(out).toContain('X-OTHER-CLIENT:flag=yes\r\n')
    // Modeled properties are authoritative: exactly one SUMMARY, the edited one.
    expect(out.match(/^SUMMARY:/gm)).toHaveLength(1)
    expect(out).toContain('SUMMARY:Edited\r\n')
    expect(out).not.toContain('SUMMARY:Original')
    // Stable through a further parse/serialize cycle.
    const back = parseIcs(out)
    expect(back.events[0].summary).toBe('Edited')
    expect(back.events[0].raw).toContain('STATUS:CANCELLED')
    expect(serializeIcsEvent(back.events[0])).toContain('STATUS:CANCELLED\r\n')
  })

  it('re-emits a stored VTIMEZONE for a custom TZID but not for an IANA zone', () => {
    const customBlock = [
      'BEGIN:VTIMEZONE',
      'TZID:/custom/Wycal_Zone',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0000',
      'TZNAME:WYZ',
      'END:STANDARD',
      'END:VTIMEZONE',
    ].join('\r\n')
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      customBlock,
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19701101T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700308T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:custom-tz@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=/custom/Wycal_Zone:20260302T100000',
      'DTEND;TZID=/custom/Wycal_Zone:20260302T110000',
      'SUMMARY:Custom zone',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:iana-tz@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=America/New_York:20260302T100000',
      'DTEND;TZID=America/New_York:20260302T110000',
      'SUMMARY:Iana zone',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events[0].timezones).toEqual([customBlock])
    expect(events[1].timezones).toBeUndefined()

    const customOut = serializeIcsEvent(events[0])
    expect(customOut).toContain(customBlock)
    expect(customOut.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(customOut.indexOf('BEGIN:VEVENT'))
    // IANA zones resolve through Intl — the block must not be duplicated.
    const ianaOut = serializeIcsEvent(events[1])
    expect(ianaOut).not.toContain('BEGIN:VTIMEZONE')
  })
})

describe('tolerant parsing', () => {
  it('lone CR in TEXT escapes to \\n like CRLF and LF do', () => {
    const text = serializeIcsEvent(mk({ summary: 'old mac\rdos\nunix' }))
    expect(text).toContain('SUMMARY:old mac\\ndos\\nunix\r\n')
    // RFC 5545 has a single \\n escape, so both breaks come back as LF.
    const { events } = parseIcs(text)
    expect(events[0].summary).toBe('old mac\ndos\nunix')
  })

  it('accepts minutes-precision RECURRENCE-ID (T0900 → 09:00:00)', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:min-prec@example.test',
      'DTSTAMP:20260101T000000Z',
      'RECURRENCE-ID:20260303T0900',
      'DTSTART:20260303T093000',
      'SUMMARY:Moved (minutes precision)',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events[0].recurrenceId).toBe('2026-03-03T09:00:00')
    expect(events[0].start).toEqual({ utc: '2026-03-03T09:30:00.000Z', floating: true })
  })

  it('rejects impossible dates to the epoch fallback instead of throwing', () => {
    const mkText = (dtstart: string): string =>
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:bad@example.test',
        'DTSTAMP:20260101T000000Z',
        `DTSTART:${dtstart}`,
        'DTEND:20260302T110000Z',
        'SUMMARY:Bad date',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n')
    expect(parseIcs(mkText('20261340')).events[0].start).toEqual({ utc: '1970-01-01T00:00:00.000Z' })
    expect(parseIcs(mkText('20260302T250000Z')).events[0].start).toEqual({ utc: '1970-01-01T00:00:00.000Z' })
    expect(parseIcs(mkText('20261332T100000Z')).events[0].start).toEqual({ utc: '1970-01-01T00:00:00.000Z' })
  })

  it('drops a DTEND earlier than DTSTART (zero duration at DTSTART)', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:reversed@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T110000Z',
      'DTEND:20260302T100000Z',
      'SUMMARY:Reversed',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events[0].start).toEqual({ utc: '2026-03-02T11:00:00.000Z' })
    expect(events[0].end).toEqual({ utc: '2026-03-02T11:00:00.000Z' })
  })

  it('finalizes an unterminated VEVENT at EOF instead of dropping it', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:dangling@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T100000Z',
      'DTEND:20260302T110000Z',
      'SUMMARY:Dangling',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('Dangling')
    expect(events[0].start).toEqual({ utc: '2026-03-02T10:00:00.000Z' })
    expect(events[0].raw).toContain('SUMMARY:Dangling')
  })

  it('finalizes an unterminated VEVENT closed only by END:VCALENDAR', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cut@example.test',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260302T100000Z',
      'DTEND:20260302T110000Z',
      'SUMMARY:Cut short',
      'END:VCALENDAR',
      '',
    ].join('\r\n')
    const { events } = parseIcs(text)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('Cut short')
    expect(events[0].start).toEqual({ utc: '2026-03-02T10:00:00.000Z' })
  })
})
