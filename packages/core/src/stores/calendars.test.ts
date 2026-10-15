/**
 * Calendar visibility tests (CONTRACTS §34): the schedule and agenda domains
 * keep INDEPENDENT membership, persisted under separate keys. The mobile
 * schedule tab feeds from 'schedule' and the agenda tab from 'agenda'
 * (CONTRACTS §38), so a regression here silently couples the two surfaces.
 */
import { afterAll, expect, test } from 'bun:test'
import type { DavCollection } from '../lib/caldav/types'
import { setKvBackend } from '../lib/kv'
import type { KvBackend } from '../lib/kv'

/**
 * Private kv for this file: membership writes must be observable (both key
 * pairs are asserted) and must not reach a real storage global. It is
 * installed BEFORE the store module loads, because the store hydrates its sets
 * at import time — which is why `./calendars` is imported dynamically below: a
 * static import would hoist above `setKvBackend` and observe empty sets.
 */
const cells = new Map<string, string>()
const memoryKv: KvBackend = {
	get: (key) => cells.get(key) ?? null,
	set: (key, value) => {
		cells.set(key, value)
	},
	remove: (key) => {
		cells.delete(key)
	},
}
setKvBackend(memoryKv)

/**
 * bun runs every test file in ONE process over ONE shared module graph, so both
 * the swapped seam AND the store's own signals stay changed for every later
 * file in the run — an earlier version of this file broke `snapshot.test.ts`
 * ("hydrate tolerates malformed input", which expects an empty `collections`
 * and an untouched `wycal.visible`). Hand the process back what a pristine
 * load would see: no registered collections, both visibility domains empty,
 * and the backend `lib/kv` installs on its own.
 */
afterAll(() => {
	collections.value = []
	applyVisibility('schedule', new Set())
	applyVisibility('agenda', new Set())
	setKvBackend(defaultKvBackend())
})

/** Mirror of `lib/kv`'s own default: localStorage when the runtime has it,
 *  else a private in-memory map. */
function defaultKvBackend(): KvBackend {
	const storage = typeof localStorage === 'undefined' ? null : localStorage
	if (storage) {
		return {
			get: (key) => storage.getItem(key),
			set: (key, value) => storage.setItem(key, value),
			remove: (key) => storage.removeItem(key),
		}
	}
	const map = new Map<string, string>()
	return {
		get: (key) => map.get(key) ?? null,
		set: (key, value) => {
			map.set(key, value);
		},
		remove: (key) => {
			map.delete(key);
		},
	}
}

const {
  applyVisibility,
  collections,
  isCalendarVisible,
  registerCollections,
  setVisible,
  toggleCalendar,
  visibilityVersion,
} = await import('./calendars')

const CAL_A = 'http://127.0.0.1:5232/demo/a.ics'
const CAL_B = 'http://127.0.0.1:5232/demo/b.ics'
const CAL_C = 'http://127.0.0.1:5232/demo/c.ics'
const CAL_D = 'http://127.0.0.1:5232/demo/d.ics'
const CAL_E = 'http://127.0.0.1:5232/demo/e.ics'
const CAL_F = 'http://127.0.0.1:5232/demo/f.ics'
const CAL_G = 'http://127.0.0.1:5232/demo/g.ics'

const cal = (url: string): DavCollection => ({
  url,
  name: url,
  kind: 'calendar',
  components: ['VEVENT'],
})

/** One persisted URL set, read from the key the store writes. */
const persisted = (key: string): string[] => JSON.parse(cells.get(key) ?? '[]') as string[]

test('an unregistered URL is hidden everywhere; registration surfaces it in every domain', () => {
  expect(isCalendarVisible(CAL_A)).toBe(false)
  expect(isCalendarVisible(CAL_A, 'agenda')).toBe(false)

  registerCollections([cal(CAL_A)])

  expect(isCalendarVisible(CAL_A, 'schedule')).toBe(true)
  expect(isCalendarVisible(CAL_A, 'agenda')).toBe(true)
})

test('hiding in one domain leaves the other domain untouched and persists per-domain keys', () => {
  registerCollections([cal(CAL_B)])

  setVisible('agenda', CAL_B, false)
  expect(isCalendarVisible(CAL_B, 'agenda')).toBe(false)
  expect(isCalendarVisible(CAL_B, 'schedule')).toBe(true)
  expect(isCalendarVisible(CAL_B)).toBe(true) // default domain is 'schedule'
  expect(persisted('wycal.agenda.hidden')).toContain(CAL_B)
  expect(persisted('wycal.hidden')).not.toContain(CAL_B)

  setVisible('schedule', CAL_B, false)
  expect(isCalendarVisible(CAL_B, 'schedule')).toBe(false)
  expect(isCalendarVisible(CAL_B, 'agenda')).toBe(false)

  // Restoring the schedule must not restore the agenda domain.
  setVisible('schedule', CAL_B, true)
  expect(isCalendarVisible(CAL_B, 'schedule')).toBe(true)
  expect(isCalendarVisible(CAL_B, 'agenda')).toBe(false)
  expect(persisted('wycal.agenda.hidden')).toContain(CAL_B)
})

test('re-discovery keeps an explicitly hidden calendar hidden in that domain only', () => {
  registerCollections([cal(CAL_C)])
  setVisible('agenda', CAL_C, false)

  // Every sync re-registers the same collections; hidden must not resurface.
  registerCollections([cal(CAL_C)])

  expect(isCalendarVisible(CAL_C, 'agenda')).toBe(false)
  expect(isCalendarVisible(CAL_C, 'schedule')).toBe(true)
})

test('toggleCalendar defaults to the schedule domain', () => {
  registerCollections([cal(CAL_D)])

  toggleCalendar(CAL_D)
  expect(isCalendarVisible(CAL_D, 'schedule')).toBe(false)
  expect(isCalendarVisible(CAL_D, 'agenda')).toBe(true)

  toggleCalendar(CAL_D)
  expect(isCalendarVisible(CAL_D, 'schedule')).toBe(true)
})

test('visibilityVersion bumps for effective changes only', () => {
  registerCollections([cal(CAL_E)])
  const before = visibilityVersion.value

  setVisible('schedule', CAL_E, false)
  expect(visibilityVersion.value).toBe(before + 1)

  setVisible('schedule', CAL_E, false) // already hidden — no-op
  expect(visibilityVersion.value).toBe(before + 1)

  setVisible('agenda', CAL_E, false) // a change in the other domain still counts
  expect(visibilityVersion.value).toBe(before + 2)
})

test('applyVisibility whitelists one domain only and is idempotent', () => {
  registerCollections([cal(CAL_F), cal(CAL_G)])
  const before = visibilityVersion.value

  applyVisibility('schedule', new Set([CAL_F]))

  expect(isCalendarVisible(CAL_F, 'schedule')).toBe(true)
  expect(isCalendarVisible(CAL_G, 'schedule')).toBe(false)
  expect(isCalendarVisible(CAL_F, 'agenda')).toBe(true)
  expect(isCalendarVisible(CAL_G, 'agenda')).toBe(true)
  expect(persisted('wycal.hidden')).toContain(CAL_G)
  expect(persisted('wycal.agenda.hidden')).not.toContain(CAL_G)

  const afterApply = visibilityVersion.value
  expect(afterApply).toBe(before + 1)

  applyVisibility('schedule', new Set([CAL_F])) // identical set — no version churn
  expect(visibilityVersion.value).toBe(afterApply)
})
