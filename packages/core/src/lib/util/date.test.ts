// Data-layer tests for the ONE shared event-range formatter (CONTRACTS §38):
// it backs the web detail popover + search rows and the mobile agenda list,
// event sheet and quick-add preview. Expectations are built from the same
// public formatters (fmtDate/fmtTime) because Intl formats with the runtime
// locale — these assertions pin the branch structure, not the words.
import { describe, expect, it } from 'bun:test'
import { addDays, dayKey, fmtDate, fmtEventRange, fmtTime } from './date'

const start = new Date(2026, 9, 14, 14, 0) // Wed Oct 14 2026, 14:00 local
const sameDayEnd = new Date(2026, 9, 14, 15, 30)
const nextDay = new Date(2026, 9, 15, 9, 0) // Thu Oct 15, 09:00

// All-day DTEND is EXCLUSIVE, so a one-day all-day event ends the next day.
const oneDayAllDayEnd = new Date(2026, 9, 15)
const threeDayAllDayEnd = new Date(2026, 9, 17) // Oct 14 – Oct 16

const day = (d: Date) => fmtDate(d, { weekday: true })

describe('fmtEventRange', () => {
  it('prints a single day for a one-day all-day event (DTEND = DTSTART + 1d)', () => {
    const out = fmtEventRange(start, oneDayAllDayEnd, true, false)
    expect(out).toBe(day(start))
    // The regression: comparing the raw DTEND made this a `Oct 14 – Oct 14` range.
    expect(out).not.toContain('–')
  })

  it('prints the inclusive last day for a multi-day all-day event', () => {
    expect(fmtEventRange(start, threeDayAllDayEnd, true, false)).toBe(
      `${day(start)} – ${day(addDays(threeDayAllDayEnd, -1))}`,
    )
  })

  it('keeps both ends across a month boundary (exclusive DTEND still steps back)', () => {
    const nov30 = new Date(2026, 10, 30)
    const dec2 = new Date(2026, 11, 2) // → displayed last day Dec 1
    expect(fmtEventRange(nov30, dec2, true, false)).toBe(`${day(nov30)} – ${day(addDays(dec2, -1))}`)
  })

  it('prints the start day for an all-day event with no end', () => {
    expect(fmtEventRange(start, undefined, true, false)).toBe(day(start))
  })

  it('prints `day · start – end` for a same-day timed event', () => {
    expect(fmtEventRange(start, sameDayEnd, false, false)).toBe(
      `${day(start)} · ${fmtTime(start, false)} – ${fmtTime(sameDayEnd, false)}`,
    )
  })

  it('repeats the date on both sides for a cross-day timed event', () => {
    expect(fmtEventRange(start, nextDay, false, false)).toBe(
      `${day(start)} ${fmtTime(start, false)} – ${day(nextDay)} ${fmtTime(nextDay, false)}`,
    )
  })

  it('prints the start day for a timed event with no end', () => {
    expect(fmtEventRange(start, undefined, false, false)).toBe(day(start))
  })

  it('threads the hour12 pref into both times', () => {
    expect(fmtEventRange(start, sameDayEnd, false, true)).toBe(
      `${day(start)} · ${fmtTime(start, true)} – ${fmtTime(sameDayEnd, true)}`,
    )
  })

  it('steps the all-day end back exactly one local day', () => {
    // Guards the invariant itself, not just one call's text: the displayed end
    // day is the day before the exclusive DTEND.
    const last = addDays(threeDayAllDayEnd, -1)
    expect(dayKey(last)).toBe('2026-10-16')
    expect(fmtEventRange(start, threeDayAllDayEnd, true, false)).toContain(day(last))
  })
})
