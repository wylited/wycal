// nl.ts interpret() overlay tests (bun:test) — CONTRACTS §16 Q quick-add
// grammar. Dates come from the live clock (parseQuickAddLine uses `now`), so
// assertions pin pinned-clock runs via setSystemTime and only check nl-owned
// fields (kind/title/location/rrule/allDay/chips), never exact Date values.

import { describe, expect, it, setSystemTime } from 'bun:test'
import { interpret } from './nl'

// Pin the clock once per run: the base pass resolves 'tomorrow'/'friday'
// against `new Date()`, and setSystemTime controls that in bun.
setSystemTime(new Date(2026, 9, 14, 9, 0, 0)) // Wed Oct 14 2026, 09:00 local

describe('interpret — location overlays', () => {
  it('keeps day-part words out of the place name', () => {
    const r = interpret('attack at dawn')
    expect(r.location).toBeUndefined()
    expect(r.title).toBe('attack at dawn')
    expect(r.kind).toBe('todo') // bare words, no event signal
    expect(r.chips.some((c) => c.kind === 'location')).toBe(false)
  })

  it('treats every day-part as a non-place', () => {
    for (const part of ['dawn', 'dusk', 'noon', 'midnight', 'night', 'morning', 'afternoon', 'evening']) {
      expect(interpret(`attack at ${part}`).location).toBeUndefined()
    }
  })

  it('parses @place anywhere in the line, including at the end', () => {
    const lead = interpret('meet @office 3pm')
    expect(lead.location).toBe('office')
    expect(lead.kind).toBe('event')

    const tail = interpret('lunch @office')
    expect(tail.location).toBe('office')
    expect(tail.title).toBe('lunch')
    const chip = tail.chips.find((c) => c.kind === 'location')
    expect(chip?.text).toBe('@office')
    expect(chip?.start).toBe(6)
    expect(chip?.end).toBe(13)
  })

  it('keeps the typed case of an @place handle', () => {
    expect(interpret('sync @HKUST').location).toBe('HKUST')
  })

  it('does not treat @<time> as a place', () => {
    const r = interpret('sync @3pm')
    expect(r.location).toBeUndefined()
  })

  it('still parses a plain at-place', () => {
    const r = interpret("lunch at joe's pizza")
    expect(r.location).toBe("joe's pizza")
    expect(r.title).toBe('lunch')
    expect(r.kind).toBe('event') // location is an event signal
  })

  it('stops the place name at a following date', () => {
    const r = interpret('lunch at cafe tomorrow')
    expect(r.location).toBe('cafe')
    expect(r.title).toBe('lunch')
    expect(r.due).not.toBeUndefined() // 'tomorrow' still parses as the date
  })

  it('never lets all day join the place name', () => {
    const r = interpret('offsite at cafe all day')
    expect(r.location).toBe('cafe')
    expect(r.allDay).toBe(true)
    expect(r.title).toBe('offsite')
  })
})

describe('interpret — all day', () => {
  it('consumes "all day" before the date and flags allDay', () => {
    const r = interpret('all day tomorrow')
    expect(r.allDay).toBe(true)
    expect(r.kind).toBe('event')
    expect(r.title).toBe('')
    expect(r.due).not.toBeUndefined() // the date still parses (base pass)
    expect(r.when).toBeUndefined() // all-day → no wall-clock start
    const chip = r.chips.find((c) => c.text === 'all day')
    expect(chip?.kind).toBe('date')
    expect(chip?.start).toBe(0)
    expect(chip?.end).toBe(7)
  })

  it('consumes a trailing all day after a weekday', () => {
    const r = interpret('day off friday all day')
    expect(r.allDay).toBe(true)
    expect(r.kind).toBe('event')
    expect(r.title).toBe('day off')
    expect(r.due).not.toBeUndefined()
    expect(r.due?.getDay()).toBe(5) // friday
  })

  it('consumes the hyphenated all-day token', () => {
    const r = interpret('friday all-day')
    expect(r.allDay).toBe(true)
    expect(r.title).toBe('')
    expect(r.kind).toBe('event')
  })
})

describe('interpret — default kind rule', () => {
  it('event when a clock time parsed', () => {
    const r = interpret('meet 3pm at cafe')
    expect(r.kind).toBe('event')
    expect(r.location).toBe('cafe')
    expect(r.title).toBe('meet')
    expect(r.when).not.toBeUndefined()
  })

  it('event when a duration parsed', () => {
    const r = interpret('sync 30m')
    expect(r.kind).toBe('event')
    expect(r.durationMin).toBe(30)
  })

  it('event when a recurrence parsed', () => {
    const r = interpret('gym mondays')
    expect(r.kind).toBe('event')
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
  })

  it('event when only a location parsed', () => {
    const r = interpret('lunch at cafe')
    expect(r.kind).toBe('event')
    expect(r.location).toBe('cafe')
  })

  it('todo for bare words', () => {
    const r = interpret('buy milk')
    expect(r.kind).toBe('todo')
    expect(r.due).toBeUndefined()
    expect(r.location).toBeUndefined()
    expect(r.rrule).toBeUndefined()
  })

  it('todo for date-only lines — the date reads as the due', () => {
    const r = interpret('meet tomorrow')
    expect(r.kind).toBe('todo')
    expect(r.due).not.toBeUndefined()
    expect(r.allDay).toBe(true)
  })

  it('a forced prefix pins the kind ahead of the rule', () => {
    expect(interpret('todo: call mom at 3pm').kind).toBe('todo')
    expect(interpret('event: water the plants').kind).toBe('event')
  })
})

describe('interpret — recurrence-only lines', () => {
  it('every day alone yields an empty title with the rrule set', () => {
    const r = interpret('every day')
    expect(r.rrule).toBe('FREQ=DAILY')
    expect(r.title).toBe('')
    expect(r.kind).toBe('event')
    const chip = r.chips.find((c) => c.kind === 'recurrence')
    expect(chip?.text).toBe('every day')
  })
})

describe('interpret — contacts vs events', () => {
  it('keeps meet + clock time an event — no contact false positive', () => {
    const r = interpret('meet bob at 3pm')
    expect(r.kind).toBe('event')
    expect(r.contact).toBeUndefined()
    expect(r.when).not.toBeUndefined()
    expect(r.confidence).toBe('high')
  })

  it('an email still makes the line a contact per the existing rules', () => {
    const r = interpret('call bob bob@x.com')
    expect(r.kind).toBe('contact')
    expect(r.contact?.fn).toBe('bob')
    expect(r.contact?.email).toBe('bob@x.com')
  })
})
