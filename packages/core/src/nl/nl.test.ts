// nl.ts interpret() overlay tests (bun:test) — CONTRACTS §16 Q quick-add
// grammar. The clock is pinned once below via setSystemTime (the base pass
// resolves 'tomorrow'/'friday' against `now`), so both nl-owned-field
// assertions (kind/title/location/rrule/allDay/chips) and exact pinned-date
// assertions (recurrence roll) are deterministic.

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

describe('interpret — due keyword', () => {
  it("todo: Report due Friday → title 'Report', Friday due, both tokens chipped", () => {
    const r = interpret('todo: Report due Friday')
    expect(r.kind).toBe('todo')
    expect(r.title).toBe('Report')
    expect(r.due?.getDay()).toBe(5)
    expect(r.allDay).toBe(true)
    expect(r.when).toBeUndefined()
    const dueChip = r.chips.find((c) => c.text === 'due')
    expect(dueChip?.kind).toBe('date')
    expect(dueChip?.start).toBe(13)
    expect(dueChip?.end).toBe(16)
    expect(r.chips.some((c) => c.text === 'Friday' && c.kind === 'date')).toBe(true)
  })

  it("lowercase 'report due friday' strips the keyword too", () => {
    const r = interpret('report due friday')
    expect(r.title).toBe('report')
    expect(r.due?.getDay()).toBe(5)
  })

  it("'due in 3 days' consumes the keyword", () => {
    const r = interpret('taxes due in 3 days')
    expect(r.title).toBe('taxes')
    expect(r.due).not.toBeUndefined()
  })

  it("'due' before a non-date stays title text", () => {
    const r = interpret('fix the due process')
    expect(r.title).toBe('fix the due process')
    expect(r.due).toBeUndefined()
  })
})

describe('interpret — weekday case and all-day order', () => {
  it('Offsite Friday all day → event, all-day Friday, title Offsite', () => {
    const r = interpret('Offsite Friday all day')
    expect(r.kind).toBe('event')
    expect(r.allDay).toBe(true)
    expect(r.title).toBe('Offsite')
    expect(r.due?.getDay()).toBe(5)
    expect(r.when).toBeUndefined()
    expect(r.chips.some((c) => c.text === 'Friday')).toBe(true)
    expect(r.chips.some((c) => c.text === 'all day')).toBe(true)
  })

  it('a capitalized weekday parses without all day too', () => {
    const r = interpret('Report Friday')
    expect(r.title).toBe('Report')
    expect(r.due?.getDay()).toBe(5)
  })
})

describe('interpret — recurrence first occurrence', () => {
  it('Gym every Monday 7am typed Wed Oct 14 → start rolls to Mon Oct 19 07:00', () => {
    const r = interpret('Gym every Monday 7am')
    expect(r.kind).toBe('event')
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
    const first = new Date(2026, 9, 19, 7, 0).getTime()
    expect(r.when?.getTime()).toBe(first)
    expect(r.due?.getTime()).toBe(first)
  })

  it('today matching the BYDAY keeps today', () => {
    const r = interpret('gym every Wednesday 7am')
    expect(r.when?.getTime()).toBe(new Date(2026, 9, 14, 7, 0).getTime())
  })

  it('an explicitly typed date wins over the roll', () => {
    const r = interpret('launch oct 20 every friday 7pm')
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(r.when?.getTime()).toBe(new Date(2026, 9, 20, 19, 0).getTime())
  })

  it('non-BYDAY rules keep the base anchor', () => {
    const r = interpret('standup daily 9am')
    expect(r.rrule).toBe('FREQ=DAILY')
    expect(r.when?.getTime()).toBe(new Date(2026, 9, 14, 9, 0).getTime())
  })
})

describe('interpret — contact tel extraction', () => {
  it('a trailing tel token fills tel and leaves a clean fn', () => {
    const r = interpret('Maya maya@example.com 555-0100')
    expect(r.kind).toBe('contact')
    expect(r.contact?.fn).toBe('Maya')
    expect(r.contact?.email).toBe('maya@example.com')
    expect(r.contact?.tel).toBe('555-0100')
    expect(r.title).toBe('Maya')
  })

  it('digit-bearing words beside the tel stay in the name', () => {
    const r = interpret('Room 12 555-0100')
    expect(r.contact?.fn).toBe('Room 12')
    expect(r.contact?.tel).toBe('555-0100')
  })

  it('a date-shaped trailing run is never a phone', () => {
    const r = interpret('Party 2026-10-14')
    expect(r.contact).toBeUndefined()
  })
})
