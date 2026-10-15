import { describe, expect, test } from 'bun:test'
import { WEEKDAYS, buildRepeat, parseRepeat, weekdayCode } from './recurrence'

const MON = new Date(2026, 9, 12) // Mon 12 Oct 2026
const THU = new Date(2026, 9, 15) // Thu 15 Oct 2026
const SUN = new Date(2026, 9, 18) // Sun 18 Oct 2026

describe('weekdayCode', () => {
  test('maps local weekday to the Monday-first BYDAY code', () => {
    expect(weekdayCode(MON)).toBe('MO')
    expect(weekdayCode(THU)).toBe('TH')
    expect(weekdayCode(SUN)).toBe('SU')
  })

  test('WEEKDAYS is in rule order, Monday first', () => {
    expect(WEEKDAYS.map((w) => w.code)).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
  })
})

describe('buildRepeat', () => {
  test('none → undefined (no repetition)', () => {
    expect(buildRepeat({ preset: 'none', interval: 1, byDay: ['MO'] }, MON)).toBeUndefined()
  })

  test('weekly uses the start date weekday', () => {
    expect(buildRepeat({ preset: 'weekly', interval: 1, byDay: ['SU'] }, THU)).toBe('FREQ=WEEKLY;BYDAY=TH')
  })

  test('fixed presets emit their canonical rules', () => {
    expect(buildRepeat({ preset: 'daily', interval: 1, byDay: ['MO'] }, MON)).toBe('FREQ=DAILY')
    expect(buildRepeat({ preset: 'weekdays', interval: 1, byDay: [] }, MON)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(buildRepeat({ preset: 'monthly', interval: 1, byDay: ['MO'] }, MON)).toBe('FREQ=MONTHLY')
    expect(buildRepeat({ preset: 'yearly', interval: 1, byDay: ['MO'] }, MON)).toBe('FREQ=YEARLY')
  })

  test('custom emits WEEKLY with INTERVAL and the selected BYDAY set', () => {
    expect(buildRepeat({ preset: 'custom', interval: 2, byDay: ['MO', 'WE'] }, MON)).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
    )
  })

  test('custom clamps a broken interval and falls back to the start weekday', () => {
    expect(buildRepeat({ preset: 'custom', interval: 0, byDay: [] }, THU)).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=TH')
  })
})

describe('parseRepeat', () => {
  test('no rrule → none', () => {
    expect(parseRepeat(undefined, MON)).toEqual({ preset: 'none', interval: 1, byDay: ['MO'] })
  })

  test('in-vocabulary rules map to their presets', () => {
    expect(parseRepeat('FREQ=DAILY', MON).preset).toBe('daily')
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', MON)).toEqual({
      preset: 'weekdays',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
    })
    expect(parseRepeat('FREQ=WEEKLY;BYDAY=TH', MON)).toEqual({ preset: 'weekly', interval: 1, byDay: ['TH'] })
    expect(parseRepeat('FREQ=MONTHLY', MON).preset).toBe('monthly')
    expect(parseRepeat('FREQ=YEARLY', MON).preset).toBe('yearly')
  })

  test('weekly without BYDAY degrades to the start weekday fallback', () => {
    expect(parseRepeat('FREQ=WEEKLY', THU)).toEqual({ preset: 'weekly', interval: 1, byDay: ['TH'] })
  })

  test('INTERVAL > 1 forces custom (kept, not dropped)', () => {
    expect(parseRepeat('FREQ=DAILY;INTERVAL=2', MON)).toEqual({ preset: 'custom', interval: 2, byDay: ['MO'] })
    expect(parseRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', MON)).toEqual({ preset: 'custom', interval: 2, byDay: ['MO'] })
  })

  test('clauses outside the vocabulary force custom so the rule round-trips verbatim while untouched', () => {
    expect(parseRepeat('FREQ=MONTHLY;BYMONTHDAY=15', MON).preset).toBe('custom')
    expect(parseRepeat('FREQ=MONTHLY;BYDAY=2MO', MON).preset).toBe('custom')
    expect(parseRepeat('FREQ=YEARLY;BYMONTH=3', MON).preset).toBe('custom')
    expect(parseRepeat('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO', MON).preset).toBe('custom')
  })

  test('build∘parse is the identity for every in-vocabulary rule', () => {
    expect(buildRepeat(parseRepeat('FREQ=DAILY', MON), MON)).toBe('FREQ=DAILY')
    expect(buildRepeat(parseRepeat('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', MON), MON)).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(buildRepeat(parseRepeat('FREQ=WEEKLY;BYDAY=TH', THU), THU)).toBe('FREQ=WEEKLY;BYDAY=TH')
    expect(buildRepeat(parseRepeat('FREQ=MONTHLY', MON), MON)).toBe('FREQ=MONTHLY')
    expect(buildRepeat(parseRepeat('FREQ=YEARLY', MON), MON)).toBe('FREQ=YEARLY')
    expect(buildRepeat(parseRepeat('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', MON), MON)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')
  })
})
