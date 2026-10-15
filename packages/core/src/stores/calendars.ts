/**
 * Calendar-collection store (CONTRACTS §4).
 *
 * Visibility rules: visibility is PER MODE (§nav-revamp) — the schedule grid
 * and the agenda list each gate their content with an independent domain
 * ('schedule' | 'agenda'), so toggling a calendar off in the agenda sidebar
 * leaves it on in the schedule grid and vice versa. Each domain keeps a
 * visible URL set (schedule: `wycal.visible`, agenda: `wycal.agenda.visible`)
 * plus a companion explicit-hide set (`wycal.hidden` / `wycal.agenda.hidden`)
 * so that a hidden calendar does not come back as "newly discovered → default
 * visible" after a reload. Collections never seen before default to visible
 * on first discovery in every domain (spec): the schedule domain keeps the
 * original storage keys, so pre-split persisted sets seed it as-is, while the
 * agenda domain starts empty and therefore defaults to all-visible.
 */
import { computed, signal, type Signal } from '@preact/signals-core'
import type { DavCollection } from '../lib/caldav/types'
import { kv } from '../lib/kv'
import { clientForCollection, httpStatus, requestSync } from '../lib/sync/engine'
import { EVENT_COLORS } from '../lib/util/colors'
import { push } from './toasts'

export type VisibilityDomain = 'schedule' | 'agenda'

/** Per-domain storage keys; the schedule domain keeps the original keys, so
 * pre-split persisted sets seed it as-is (the agenda domain starts empty =
 * all visible). */
const STORAGE_KEYS: Record<VisibilityDomain, { visible: string; hidden: string }> = {
  schedule: { visible: 'wycal.visible', hidden: 'wycal.hidden' },
  agenda: { visible: 'wycal.agenda.visible', hidden: 'wycal.agenda.hidden' },
}

function loadSet(key: string): Set<string> {
  try {
    const raw = kv.get(key)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch (err) {
    console.warn(`wycal: could not read ${key}`, err)
    return new Set()
  }
}

function persist(domain: VisibilityDomain): void {
  const d = domains[domain]
  try {
    kv.set(STORAGE_KEYS[domain].visible, JSON.stringify([...d.visible.value]))
    kv.set(STORAGE_KEYS[domain].hidden, JSON.stringify([...d.hidden.value]))
  } catch (err) {
    console.warn('wycal: could not persist calendar visibility', err)
  }
}

/** All discovered collections (calendars + addressbooks), engine-populated. */
export const collections = signal<DavCollection[]>([])

/** Independent per-mode visibility state: each domain gates its own views
 * with its own sets, persisted under its own keys. */
const domains: Record<VisibilityDomain, { visible: Signal<Set<string>>; hidden: Signal<Set<string>> }> = {
  schedule: {
    visible: signal(loadSet(STORAGE_KEYS.schedule.visible)),
    hidden: signal(loadSet(STORAGE_KEYS.schedule.hidden)),
  },
  agenda: {
    visible: signal(loadSet(STORAGE_KEYS.agenda.visible)),
    hidden: signal(loadSet(STORAGE_KEYS.agenda.hidden)),
  },
}

/** Bumped whenever visibility membership changes in ANY domain (refetch
 * signal for feeds; the events store's occurrence buckets deliberately do
 * NOT key on it). */
export const visibilityVersion = signal(0)

/** Schedule-domain visible URL set (search corpus + editor pickers read it;
 * agenda-side code asks `isCalendarVisible(url, 'agenda')` instead). */
export const visibleCalendars = computed<ReadonlySet<string>>(
  () => new Set(domains.schedule.visible.value),
)

/** Schedule-domain visible collection records, for editor pickers. */
export const visibleCollections = computed<DavCollection[]>(() =>
  collections.value.filter((c) => domains.schedule.visible.value.has(c.url)),
)

/** A collection's visibility in one domain ('schedule' by default). */
export function isCalendarVisible(url: string, domain: VisibilityDomain = 'schedule'): boolean {
  return domains[domain].visible.value.has(url)
}

/**
 * Replace the collection list after discovery. URLs never seen before become
 * visible (unless explicitly hidden) in EVERY domain; explicitly hidden ones
 * stay hidden — so a fresh domain starts all-visible (spec).
 */
export function registerCollections(cols: DavCollection[]): void {
  let changed = false
  for (const domain of ['schedule', 'agenda'] as const) {
    const d = domains[domain]
    const visible = new Set(d.visible.value)
    let domainChanged = false
    for (const c of cols) {
      if (d.hidden.value.has(c.url) || visible.has(c.url)) continue
      visible.add(c.url)
      domainChanged = true
    }
    if (domainChanged) {
      d.visible.value = visible
      persist(domain)
      changed = true
    }
  }
  collections.value = cols
  if (changed) visibilityVersion.value++
}

/** Forget collections (engine calls this when an account is removed). */
export function dropCollections(urls: ReadonlySet<string>): void {
  if (urls.size === 0) return
  collections.value = collections.value.filter((c) => !urls.has(c.url))
}

/** Set one collection's visibility in a domain and persist. */
export function setVisible(domain: VisibilityDomain, url: string, on: boolean): void {
  const d = domains[domain]
  if (on === d.visible.value.has(url)) return
  const visible = new Set(d.visible.value)
  const hidden = new Set(d.hidden.value)
  if (on) {
    visible.add(url)
    hidden.delete(url)
  } else {
    visible.delete(url)
    hidden.add(url)
  }
  d.visible.value = visible
  d.hidden.value = hidden
  persist(domain)
  visibilityVersion.value++
}

/** Toggle a collection's visibility in a domain and persist. */
export function toggleCalendar(url: string, domain: VisibilityDomain = 'schedule'): void {
  setVisible(domain, url, !domains[domain].visible.value.has(url))
}

/**
 * Replace a domain's visibility wholesale from an explicit visible-URL set
 * (saved views V2 apply, schedule domain): collections not in the set become
 * explicitly hidden so they neither render nor resurface as "newly
 * discovered" after a reload.
 */
export function applyVisibility(domain: VisibilityDomain, urls: ReadonlySet<string>): void {
  const visible = new Set<string>()
  const hidden = new Set<string>()
  for (const c of collections.value) {
    if (urls.has(c.url)) visible.add(c.url)
    else hidden.add(c.url)
  }
  const d = domains[domain]
  const sameAs = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && [...a].every((u) => b.has(u))
  if (sameAs(visible, d.visible.value) && sameAs(hidden, d.hidden.value)) return
  d.visible.value = visible
  d.hidden.value = hidden
  persist(domain)
  visibilityVersion.value++
}

/**
 * Color for a collection: its ICAL:calendar-color when set, else a
 * round-robin pick from EVENT_COLORS (design.md order) by list position.
 */
export function collectionColor(cal: DavCollection): string {
  if (cal.color && cal.color.trim().length > 0) return cal.color.trim()
  const idx = collections.value.findIndex((c) => c.url === cal.url)
  return EVENT_COLORS[Math.max(0, idx) % EVENT_COLORS.length]
}

/**
 * Optimistic calendar-color change (CONTRACTS §12): the collection list
 * updates immediately, then a PROPPATCH `ICAL:calendar-color` persists it;
 * on failure the list rolls back, a toast explains, and the error rethrows.
 */
export async function setCollectionColor(collection: DavCollection, hex: string): Promise<void> {
  const client = clientForCollection(collection.url)
  if (!client) {
    push('error', 'No account found for this calendar')
    throw new Error(`wycal: no account for collection ${collection.url}`)
  }
  const prev = collections.value
  collections.value = prev.map((c) => (c.url === collection.url ? { ...c, color: hex } : c))
  try {
    await client.proppatchColor(collection.url, hex)
  } catch (err) {
    collections.value = prev
    if (httpStatus(err) === 412) void requestSync(collection.url)
    const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
    push('error', `Could not save the calendar color${detail}`)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Offline snapshot (CONTRACTS §36 mobile boot)
// ---------------------------------------------------------------------------

function isDavCollection(v: unknown): v is DavCollection {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.url === 'string' &&
    typeof c.name === 'string' &&
    (c.kind === 'calendar' || c.kind === 'addressbook') &&
    Array.isArray(c.components) &&
    c.components.every((x) => typeof x === 'string')
  )
}

/**
 * Snapshot = the collection registry plus both domains' visible/hidden URL
 * sets — everything needed to gate views offline before the first discovery
 * round. `visibilityVersion` itself is not carried: hydrate bumps it once,
 * which is all observers need.
 */
export function serializeSnapshot(): unknown {
  return {
    collections: collections.value.map((c) => ({ ...c })),
    domains: {
      schedule: { visible: [...domains.schedule.visible.value], hidden: [...domains.schedule.hidden.value] },
      agenda: { visible: [...domains.agenda.visible.value], hidden: [...domains.agenda.hidden.value] },
    },
  }
}

/**
 * Restore registry + visibility sets. Pure memory restore — no kv writes
 * (`persist` is deliberately skipped; the kv seam holds its own copy), no
 * toasts, no network. All-or-nothing: when the shape is malformed the store
 * is left as-is (fresh-boot semantics); a missing visible/hidden array
 * inside a well-formed domain reads as empty.
 */
export function hydrateSnapshot(snap: unknown): void {
  try {
    if (typeof snap !== 'object' || snap === null) return
    const s = snap as { collections?: unknown; domains?: unknown }
    if (!Array.isArray(s.collections) || !s.collections.every(isDavCollection)) return
    if (typeof s.domains !== 'object' || s.domains === null) return
    const d = s.domains as Record<VisibilityDomain, { visible?: unknown; hidden?: unknown } | null>
    for (const domain of ['schedule', 'agenda'] as const) {
      if (typeof d[domain] !== 'object' || d[domain] === null) return
    }
    const loadArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    collections.value = s.collections.map((c) => ({ ...c }))
    for (const domain of ['schedule', 'agenda'] as const) {
      domains[domain].visible.value = new Set(loadArr(d[domain]!.visible))
      domains[domain].hidden.value = new Set(loadArr(d[domain]!.hidden))
    }
    visibilityVersion.value++
  } catch {
    // Malformed snapshot → leave the store as-is (fresh-boot semantics).
  }
}
