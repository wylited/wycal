/**
 * Calendar-collection store (CONTRACTS §4).
 *
 * Visibility rules: a collection's state is either visible or hidden. The
 * visible URL set is persisted under `wycal.visible` (as the contract
 * requires); a companion `wycal.hidden` set records explicit hides so that a
 * hidden calendar does not come back as "newly discovered → default visible"
 * after a reload. Collections never seen before default to visible on first
 * discovery (spec).
 */
import { computed, signal } from '@preact/signals'
import type { DavCollection } from '../lib/caldav/types'
import { clientForCollection, httpStatus, requestSync } from '../lib/sync/engine'
import { EVENT_COLORS } from '../lib/util/colors'
import { push } from './toasts'

const VISIBLE_STORAGE_KEY = 'wycal.visible'
const HIDDEN_STORAGE_KEY = 'wycal.hidden'

function loadSet(key: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch (err) {
    console.warn(`wycal: could not read ${key}`, err)
    return new Set()
  }
}

function persistSets(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(VISIBLE_STORAGE_KEY, JSON.stringify([...visibleUrls.value]))
    localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify([...hiddenUrls.value]))
  } catch (err) {
    console.warn('wycal: could not persist calendar visibility', err)
  }
}

/** All discovered collections (calendars + addressbooks), engine-populated. */
export const collections = signal<DavCollection[]>([])

const visibleUrls = signal<Set<string>>(loadSet(VISIBLE_STORAGE_KEY))
const hiddenUrls = signal<Set<string>>(loadSet(HIDDEN_STORAGE_KEY))

/** Bumped whenever visibility membership changes (refetch signal for feeds;
 * the events store's occurrence buckets deliberately do NOT key on it). */
export const visibilityVersion = signal(0)

/** Set of visible collection URLs (persisted 'wycal.visible'). */
export const visibleCalendars = computed<ReadonlySet<string>>(() => new Set(visibleUrls.value))

/** Visible collection records, for sidebar/lists. */
export const visibleCollections = computed<DavCollection[]>(() =>
  collections.value.filter((c) => visibleUrls.value.has(c.url)),
)

export function isCalendarVisible(url: string): boolean {
  return visibleUrls.value.has(url)
}

/**
 * Replace the collection list after discovery. URLs never seen before become
 * visible (unless explicitly hidden); explicitly hidden ones stay hidden.
 */
export function registerCollections(cols: DavCollection[]): void {
  let changed = false
  const visible = new Set(visibleUrls.value)
  for (const c of cols) {
    if (hiddenUrls.value.has(c.url) || visible.has(c.url)) continue
    visible.add(c.url)
    changed = true
  }
  collections.value = cols
  if (changed) {
    visibleUrls.value = visible
    persistSets()
    visibilityVersion.value++
  }
}

/** Forget collections (engine calls this when an account is removed). */
export function dropCollections(urls: ReadonlySet<string>): void {
  if (urls.size === 0) return
  collections.value = collections.value.filter((c) => !urls.has(c.url))
}

/** Toggle a collection's visibility and persist. */
export function toggleCalendar(url: string): void {
  const visible = new Set(visibleUrls.value)
  const hidden = new Set(hiddenUrls.value)
  if (visible.has(url)) {
    visible.delete(url)
    hidden.add(url)
  } else {
    visible.add(url)
    hidden.delete(url)
  }
  visibleUrls.value = visible
  hiddenUrls.value = hidden
  persistSets()
  visibilityVersion.value++
}

/**
 * Replace visibility wholesale from an explicit visible-URL set (saved views
 * V2 apply): collections not in the set become explicitly hidden so they
 * neither render nor resurface as "newly discovered" after a reload.
 */
export function setVisibility(urls: ReadonlySet<string>): void {
  const visible = new Set<string>()
  const hidden = new Set<string>()
  for (const c of collections.value) {
    if (urls.has(c.url)) visible.add(c.url)
    else hidden.add(c.url)
  }
  const sameAs = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
    a.size === b.size && [...a].every((u) => b.has(u))
  if (sameAs(visible, visibleUrls.value) && sameAs(hidden, hiddenUrls.value)) return
  visibleUrls.value = visible
  hiddenUrls.value = hidden
  persistSets()
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
