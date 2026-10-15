/**
 * Offline snapshot tests (CONTRACTS §36): aggregate shape, tolerance of
 * malformed input, and a hand-built fixture restoring the pure-signal stores
 * (accounts identity, calendars visibility) plus every record store. The
 * record stores are module singletons, so fresh-module shape checks run
 * first and hydrate-from-fixture stands in for set-then-assert CRUD paths —
 * no network, no kv writes, fully deterministic.
 */
import { describe, expect, test } from 'bun:test'
import { accounts } from './accounts'
import { collections, isCalendarVisible } from './calendars'
import { baseEvents, occurrences } from './events'
import { todos } from './todos'
import { contacts } from './contacts'
import { kv } from '../lib/kv'
import { hydrateSnapshot, serializeSnapshot, type WycalSnapshot } from './snapshot'

const CAL = 'http://127.0.0.1:5232/demo/personal.ics'
const VCARD_HREF = 'http://127.0.0.1:5232/demo/ab/1.vcf'

function fixtureSnapshot(agendaVisible = false): WycalSnapshot {
  return {
    version: 1,
    savedAt: '2026-10-15T00:00:00.000Z',
    stores: {
      accounts: [{ id: 'acc1', url: 'http://127.0.0.1:5232', username: 'demo', rememberPassword: true }],
      calendars: {
        collections: [
          {
            url: CAL,
            name: 'Personal',
            color: '#39bae6',
            kind: 'calendar',
            components: ['VEVENT', 'VTODO'],
            etag: '"c-e1"',
          },
        ],
        domains: {
          schedule: { visible: [CAL], hidden: [] },
          agenda: { visible: agendaVisible ? [CAL] : [], hidden: agendaVisible ? [] : [CAL] },
        },
      },
      events: {
        base: [
          [
            `uid-1@${CAL}`,
            {
              key: `${CAL}/uid-1`,
              calendarUrl: CAL,
              href: `${CAL}/uid-1.ics`,
              etag: '"v1"',
              data: {
                uid: 'uid-1',
                summary: 'Meet Bob',
                start: { utc: '2026-10-16T07:00:00.000Z' },
                end: { utc: '2026-10-16T08:00:00.000Z' },
                allDay: false,
                exdates: [],
                attendees: [],
                categories: [],
                alarms: [],
              },
            },
          ],
        ],
        overrides: [],
        revision: 3,
      },
      todos: {
        todos: [
          [
            `todo-1@${CAL}`,
            {
              key: `${CAL}/todo-1`,
              calendarUrl: CAL,
              href: `${CAL}/todo-1.ics`,
              etag: '"t1"',
              data: {
                uid: 'todo-1',
                summary: 'Buy milk',
                status: 'NEEDS-ACTION',
                categories: [],
                exdates: [],
                alarms: [],
              },
            },
          ],
        ],
        revision: 2,
      },
      contacts: {
        contacts: [
          [
            VCARD_HREF,
            {
              href: VCARD_HREF,
              etag: '"ct1"',
              data: {
                uid: 'vc-1',
                fn: 'Bob',
                emails: [],
                tels: [],
                addresses: [],
                categories: [],
                raw: 'BEGIN:VCARD\nEND:VCARD',
              },
            },
          ],
        ],
        revision: 1,
      },
    },
  }
}

describe('store snapshot', () => {
  test('aggregate serialize: version 1, ISO savedAt, exactly the five store keys, JSON-safe', () => {
    const snap = serializeSnapshot()
    expect(snap.version).toBe(1)
    expect(Number.isFinite(new Date(snap.savedAt).getTime())).toBe(true)
    expect(Object.keys(snap.stores).sort()).toEqual(['accounts', 'calendars', 'contacts', 'events', 'todos'])
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })

  test('hydrate tolerates malformed input without throwing or mutating empty stores', () => {
    for (const bad of [undefined, null, {}, { version: 2, stores: {} }, { version: 1 }, 'nope', 42]) {
      expect(() => hydrateSnapshot(bad)).not.toThrow()
    }
    expect(accounts.value).toEqual([])
    expect(collections.value).toEqual([])
    expect(baseEvents.value.size).toBe(0)
    expect(todos.value.size).toBe(0)
    expect(contacts.value.size).toBe(0)
  })

  test('fixture hydrate restores identity, visibility, and every record store offline', () => {
    hydrateSnapshot(fixtureSnapshot())

    expect(accounts.value).toEqual([
      {
        id: 'acc1',
        url: 'http://127.0.0.1:5232',
        username: 'demo',
        rememberPassword: true,
        password: '',
        needsPassword: true,
      },
    ])
    expect(collections.value).toEqual([
      {
        url: CAL,
        name: 'Personal',
        color: '#39bae6',
        kind: 'calendar',
        components: ['VEVENT', 'VTODO'],
        etag: '"c-e1"',
      },
    ])
    expect(isCalendarVisible(CAL, 'schedule')).toBe(true)
    expect(isCalendarVisible(CAL, 'agenda')).toBe(false)

    const rec = baseEvents.value.get(`uid-1@${CAL}`)
    expect(rec?.etag).toBe('"v1"')
    expect(rec?.href).toBe(`${CAL}/uid-1.ics`)
    expect(todos.value.get(`todo-1@${CAL}`)?.data.summary).toBe('Buy milk')
    expect(contacts.value.get(VCARD_HREF)?.data.fn).toBe('Bob')

    // Offline render proof: occurrences() serves the hydrated record from
    // pure signal + expansion reads — no network anywhere in the path.
    const occ = occurrences({ start: '2026-10-16T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' })
    expect(occ).toHaveLength(1)
    expect(occ[0].data.summary).toBe('Meet Bob')
    expect(occ[0].etag).toBe('"v1"')
  })

  test('hydrate writes nothing to kv and the accounts section carries no secret', () => {
    for (const key of ['wycal.accounts', 'wycal.visible', 'wycal.hidden', 'wycal.agenda.visible', 'wycal.agenda.hidden']) {
      expect(kv.get(key)).toBeNull()
    }
    const rows = serializeSnapshot().stores.accounts as Record<string, unknown>[]
    expect(rows).toEqual([{ id: 'acc1', url: 'http://127.0.0.1:5232', username: 'demo', rememberPassword: true }])
    expect('password' in rows[0]).toBe(false)
  })

  test('serialize → JSON wire → hydrate round-trip is idempotent', () => {
    hydrateSnapshot(JSON.parse(JSON.stringify(serializeSnapshot())))
    expect(baseEvents.value.get(`uid-1@${CAL}`)?.etag).toBe('"v1"')
    expect(todos.value.size).toBe(1)
    expect(contacts.value.size).toBe(1)
    expect(collections.value).toHaveLength(1)
    expect(isCalendarVisible(CAL, 'agenda')).toBe(false)
    expect(accounts.value).toHaveLength(1)
  })

  test('a malformed section is a no-op for its store and does not block the others', () => {
    const flipped = fixtureSnapshot(true)
    ;(flipped.stores as Record<string, unknown>).events = { base: 42, overrides: 'nope' }
    hydrateSnapshot(flipped)
    // events untouched (still the fixture record from the earlier hydrate)
    expect(baseEvents.value.get(`uid-1@${CAL}`)?.etag).toBe('"v1"')
    // the well-formed calendars section still applied
    expect(isCalendarVisible(CAL, 'agenda')).toBe(true)

    // a malformed record inside a section is equally inert
    hydrateSnapshot({
      version: 1,
      savedAt: '2026-10-15T00:00:00.000Z',
      stores: { todos: { todos: [[`todo-1@${CAL}`, 'garbage']], revision: 9 } },
    })
    expect(todos.value.size).toBe(1)
    expect(todos.value.get(`todo-1@${CAL}`)?.data.summary).toBe('Buy milk')
  })
})
