/**
 * Event store (CONTRACTS §4).
 *
 * State: two signals of Maps — `baseEvents` (series masters, key `uid@cal`)
 * and `overrides` (RECURRENCE-ID exceptions, key `uid@cal#recId`) — plus a
 * `revision` counter bumped on every mutation (UI refetch signal) and a
 * per-calendar version map that keys the occurrence month-bucket cache.
 *
 * CRUD is optimistic with snapshot-rollback + toast on failure; per the
 * Radicale error law a 412 (stale If-Match) additionally re-syncs the
 * collection so the store converges to server truth. Every successful mutation
 * fires `requestSync(calendarUrl)` (debounced, engine).
 *
 * Series-edit scopes (CONTRACTS §4/§5 simplification of THISANDFUTURE):
 * - 'all'    → patch the base VEVENT (or the override itself when orphaned).
 * - 'this'   → write a separate override VEVENT with RECURRENCE-ID.
 * - 'future' → set UNTIL on the old base just before the cut and create a new
 *              series VEVENT (new UID) starting at the cut, carrying the patch,
 *              with COUNT adjusted when the original rule was counted;
 *              overrides at/after the cut move to the new series.
 */
import { signal } from '@preact/signals'
import type { CaldavClient } from '../lib/caldav/client'
import type { IcsDate, IcsEvent, IcsTodo } from '../lib/ics/types'
import { pad2, shiftIcsDate } from '../lib/ics/types'
import { expandEvents } from '../lib/ics/expand'
import { serializeIcsEvent, serializeIcsEvents } from '../lib/ics/serialize'
import { clientForCollection, httpStatus, requestSync } from '../lib/sync/engine'
import { newUid } from '../lib/util/id'
import {
  canonicalInstant,
  countOccurrencesBefore,
  icsDateToDate,
  mirrorIcsDate,
  parseRecId,
  rruleCount,
  rruleWithoutUntil,
  setRruleParam,
  setRruleUntil,
} from '../lib/util/date'
import { isCalendarVisible } from './calendars'
import { push } from './toasts'

export interface EventRecord {
  /** `calendarUrl + '/' + uid [+ '#' + recurrenceId]` (FullCalendar event id). */
  key: string
  calendarUrl: string
  href: string
  etag: string
  data: IcsEvent
}

export type EventPatch = Partial<Omit<IcsEvent, 'uid' | 'recurrenceId' | 'raw'>>
export type EditScope = 'all' | 'this' | 'future'
type DeleteScope = 'all' | 'this' | 'future'
/**
 * One fetched calendar object, already parsed into its VEVENTs (plus any
 * VTODOs in the same object — the engine routes those to the todos store,
 * CONTRACTS §13).
 */
export interface ParsedEventObject {
  href: string
  etag: string
  events: IcsEvent[]
  todos: IcsTodo[]
}

export const baseEvents = signal<Map<string, EventRecord>>(new Map())
export const overrides = signal<Map<string, EventRecord>>(new Map())
export const revision = signal(0)

export function baseKey(uid: string, calendarUrl: string): string {
  return `${uid}@${calendarUrl}`
}

function overrideKey(uid: string, calendarUrl: string, recId: string): string {
  return `${uid}@${calendarUrl}#${recId}`
}

function recordKey(calendarUrl: string, uid: string, recId?: string): string {
  return `${calendarUrl}/${uid}${recId ? `#${recId}` : ''}`
}

/** Object href on the server: `<calendar>/<uid>[-<recurrenceId>].ics`, uid and
 * RECURRENCE-ID suffix percent-encoded to match Radicale's emitted hrefs (its
 * reports percent-encode e.g. '@' as %40), so delta deletions exact-match. */
export function hrefForEvent(calendarUrl: string, uid: string, recId?: string): string {
  const suffix = recId ? `-${encodeURIComponent(recId.replace(/[^A-Za-z0-9._-]/g, '-'))}` : ''
  return `${calendarUrl.replace(/\/+$/, '')}/${encodeURIComponent(uid)}${suffix}.ics`
}

interface EventsSnapshot {
  base: Map<string, EventRecord>
  ov: Map<string, EventRecord>
}

function bump(): void {
  revision.value++
}

function snapshot(): EventsSnapshot {
  return { base: baseEvents.value, ov: overrides.value }
}

/** Signals need fresh Map identities; restore + bump re-notifies watchers. */
function restore(snap: EventsSnapshot, calendarUrl: string): void {
  baseEvents.value = snap.base
  overrides.value = snap.ov
  bump()
  bumpCalVersion(calendarUrl)
}

function mutate(map: 'base' | 'ov', calendarUrl: string, fn: (m: Map<string, EventRecord>) => void): void {
  const next = new Map(map === 'base' ? baseEvents.value : overrides.value)
  fn(next)
  if (map === 'base') baseEvents.value = next
  else overrides.value = next
  bump()
  bumpCalVersion(calendarUrl)
}

/** Update just an etag after a PUT (no content change → no revision bump, but
 * the calendar's occurrence buckets re-materialize with the fresh etag). */
function retag(map: 'base' | 'ov', key: string, etag: string): void {
  const src = map === 'base' ? baseEvents.value : overrides.value
  const prev = src.get(key)
  if (!prev || prev.etag === etag) return
  const next = new Map(src)
  next.set(key, { ...prev, etag })
  if (map === 'base') baseEvents.value = next
  else overrides.value = next
  bumpCalVersion(prev.calendarUrl)
}

/** Etag refresh for every record sharing a rewritten href (group PUT side effect). */
function retagHref(map: 'base' | 'ov', href: string, etag: string): void {
  const src = map === 'base' ? baseEvents.value : overrides.value
  let next: Map<string, EventRecord> | null = null
  const cals = new Set<string>()
  for (const [k, rec] of src) {
    if (rec.href !== href || rec.etag === etag) continue
    if (!next) next = new Map(src)
    next.set(k, { ...rec, etag })
    cals.add(rec.calendarUrl)
  }
  if (!next) return
  if (map === 'base') baseEvents.value = next
  else overrides.value = next
  for (const cal of cals) bumpCalVersion(cal)
}

/**
 * All VEVENTs co-located at `href` (a calendar-object resource can hold the
 * master plus its overrides), with the target record's slot replaced by
 * `nextData` — the body a group PUT must write so co-located VEVENTs survive
 * the rewrite instead of being clobbered.
 */
function groupAtHref(href: string, targetKey: string, nextData: IcsEvent): IcsEvent[] {
  const group: IcsEvent[] = []
  let replaced = false
  for (const rec of baseEvents.value.values()) {
    if (rec.href !== href) continue
    const isTarget = rec.key === targetKey
    group.push(isTarget ? nextData : rec.data)
    replaced = replaced || isTarget
  }
  for (const rec of overrides.value.values()) {
    if (rec.href !== href) continue
    const isTarget = rec.key === targetKey
    group.push(isTarget ? nextData : rec.data)
    replaced = replaced || isTarget
  }
  if (!replaced) group.push(nextData)
  return group
}

function requireClient(calendarUrl: string): CaldavClient {
  const client = clientForCollection(calendarUrl)
  if (!client) {
    push('error', 'No account found for this calendar')
    throw new Error(`wycal: no account for collection ${calendarUrl}`)
  }
  return client
}

function failureMessage(err: unknown, action: string): string {
  const status = httpStatus(err)
  if (status === 412) return 'This event changed on the server — reloading the latest version'
  if (status === 401 || status === 403) return `Server rejected the change (permission denied)`
  const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
  return `Could not ${action}${detail}`
}

/** Rollback + toast + (412 → per error law) collection re-sync; rethrows. */
function failPut(err: unknown, calendarUrl: string, action: string, snap: EventsSnapshot): never {
  restore(snap, calendarUrl)
  if (httpStatus(err) === 412) void requestSync(calendarUrl)
  push('error', failureMessage(err, action))
  throw err
}

// ---------------------------------------------------------------------------
// Occurrences (per-calendar month-bucket cache)
// ---------------------------------------------------------------------------

const NO_OVERRIDES = new Map<string, IcsEvent>()
/** Each bucket expands [monthStart − 2d, monthEnd + 2d] so DST-skewed wall
 * clocks near month edges stay inside the bucket that owns them. */
const BUCKET_PAD_MS = 2 * 86400000
/** Cached occurrence records across all buckets; oldest-inserted evicted. */
const OCC_BUCKET_RECORD_LIMIT = 30000

/**
 * Data version per calendar, bumped by applyCollectionSync and every mutation
 * path for that calendar. Buckets are keyed on it, so a change to one
 * calendar never invalidates another's. Visibility is deliberately NOT part
 * of the key: toggling it just includes/excludes whole cached buckets.
 */
const calVersions = new Map<string, number>()

interface OccBucket {
  records: EventRecord[]
}
const occBuckets = new Map<string, OccBucket>() // `${calId}|${version}|${YYYY-MM}`
let occCachedRecords = 0

function bumpCalVersion(calendarUrl: string): void {
  const version = (calVersions.get(calendarUrl) ?? 0) + 1
  calVersions.set(calendarUrl, version)
  const keep = `${calendarUrl}|${version}|`
  for (const key of [...occBuckets.keys()]) {
    if (!key.startsWith(`${calendarUrl}|`) || key.startsWith(keep)) continue
    occCachedRecords -= occBuckets.get(key)!.records.length
    occBuckets.delete(key)
  }
}

/**
 * Concrete occurrences in [start, end) across *visible* calendars only.
 * Returns materialized EventRecords: `.data` is the concrete occurrence
 * (recurrenceId set when part of a series), `.href`/`.etag` point at the file
 * that `updateEvent`/`deleteEvent` should write. Served from per-calendar
 * month buckets (expansion happens once per calendar × month × data
 * version); the padded buckets overlap, so boundary occurrences are deduped
 * by key before the exact overlap filter runs.
 */
export function occurrences(range: { start: string; end: string }): EventRecord[] {
  const rangeStart = new Date(range.start).getTime()
  const rangeEnd = new Date(range.end).getTime()
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return []
  const calendars = new Set<string>()
  for (const rec of baseEvents.value.values()) {
    if (isCalendarVisible(rec.calendarUrl)) calendars.add(rec.calendarUrl)
  }
  const out: EventRecord[] = []
  const seen = new Set<string>()
  const first = new Date(rangeStart)
  const month = new Date(first.getFullYear(), first.getMonth(), 1)
  for (; month.getTime() < rangeEnd; month.setMonth(month.getMonth() + 1)) {
    const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1)
    const ym = `${month.getFullYear()}-${pad2(month.getMonth() + 1)}`
    for (const cal of calendars) {
      for (const rec of bucket(cal, ym, month, monthEnd)) {
        if (seen.has(rec.key)) continue
        seen.add(rec.key)
        // Same interval-overlap rule as expandEvents: multi-day events that
        // begin before the window still count; missing ends get a nominal
        // one-day span.
        const startMs = icsDateToDate(rec.data.start).getTime()
        if (startMs >= rangeEnd) continue
        const endMs = icsDateToDate(rec.data.end ?? shiftIcsDate(rec.data.start, 86400000)).getTime()
        if (endMs <= rangeStart) continue
        out.push(rec)
      }
    }
  }
  out.sort((a, b) => icsDateToDate(a.data.start).getTime() - icsDateToDate(b.data.start).getTime())
  return out
}

/** Cached (lazily computed) occurrence records of one calendar-month bucket. */
function bucket(calendarUrl: string, ym: string, monthStart: Date, monthEnd: Date): EventRecord[] {
  const key = `${calendarUrl}|${calVersions.get(calendarUrl) ?? 0}|${ym}`
  let b = occBuckets.get(key)
  if (!b) {
    b = { records: computeBucket(calendarUrl, monthStart, monthEnd) }
    occBuckets.set(key, b)
    occCachedRecords += b.records.length
    while (occCachedRecords > OCC_BUCKET_RECORD_LIMIT && occBuckets.size > 1) {
      const oldest = occBuckets.keys().next()
      if (oldest.done) break
      occCachedRecords -= occBuckets.get(oldest.value)!.records.length
      occBuckets.delete(oldest.value)
    }
  }
  return b.records
}

function computeBucket(calendarUrl: string, monthStart: Date, monthEnd: Date): EventRecord[] {
  const grouped = new Map<string, Map<string, IcsEvent>>()
  for (const rec of overrides.value.values()) {
    const recId = rec.data.recurrenceId
    if (rec.calendarUrl !== calendarUrl || !recId) continue
    const bk = baseKey(rec.data.uid, calendarUrl)
    let g = grouped.get(bk)
    if (!g) {
      g = new Map()
      grouped.set(bk, g)
    }
    g.set(recId, rec.data)
  }
  const range = {
    start: new Date(monthStart.getTime() - BUCKET_PAD_MS).toISOString(),
    end: new Date(monthEnd.getTime() + BUCKET_PAD_MS).toISOString(),
  }
  const out: EventRecord[] = []
  for (const rec of baseEvents.value.values()) {
    if (rec.calendarUrl !== calendarUrl) continue
    const ov = grouped.get(baseKey(rec.data.uid, calendarUrl)) ?? NO_OVERRIDES
    for (const occ of expandEvents(rec.data, ov, range)) out.push(materialize(rec, occ))
  }
  out.sort((a, b) => icsDateToDate(a.data.start).getTime() - icsDateToDate(b.data.start).getTime())
  return out
}

function materialize(base: EventRecord, occ: IcsEvent): EventRecord {
  const recId = occ.recurrenceId
  if (!recId) return { ...base, data: occ }
  const existing = overrides.value.get(overrideKey(occ.uid, base.calendarUrl, recId))
  if (existing) return { ...existing, data: occ }
  return {
    key: recordKey(base.calendarUrl, occ.uid, recId),
    calendarUrl: base.calendarUrl,
    href: base.href,
    etag: base.etag,
    data: occ,
  }
}

/** The series-master record behind `record` (itself when not an exception). */
function resolveBaseRecord(record: EventRecord): EventRecord {
  if (!record.data.recurrenceId) return record
  return baseEvents.value.get(baseKey(record.data.uid, record.calendarUrl)) ?? record
}

// ---------------------------------------------------------------------------
// Engine feed (whole-collection sync apply; one revision bump per batch)
// ---------------------------------------------------------------------------

export function applyCollectionSync(
  calendarUrl: string,
  objs: ParsedEventObject[],
  deletedHrefs: string[],
  full: boolean,
): void {
  const nextBase = new Map(baseEvents.value)
  const nextOv = new Map(overrides.value)
  const liveHrefs = new Set<string>()
  const warnedDupUids = new Set<string>()
  for (const o of objs) {
    liveHrefs.add(o.href)
    for (const ev of o.events) {
      if (!ev.uid) continue
      if (ev.recurrenceId) {
        nextOv.set(overrideKey(ev.uid, calendarUrl, ev.recurrenceId), {
          key: recordKey(calendarUrl, ev.uid, ev.recurrenceId),
          calendarUrl,
          href: o.href,
          etag: o.etag,
          data: ev,
        })
      } else {
        const key = baseKey(ev.uid, calendarUrl)
        const prev = nextBase.get(key)
        if (prev && prev.href !== o.href && !warnedDupUids.has(key)) {
          warnedDupUids.add(key)
          console.warn(
            `[wycal/events] duplicate UID ${ev.uid} in ${calendarUrl}: ${o.href} supersedes ${prev.href} (last wins)`,
          )
        }
        nextBase.set(key, {
          key: recordKey(calendarUrl, ev.uid),
          calendarUrl,
          href: o.href,
          etag: o.etag,
          data: ev,
        })
      }
    }
  }
  if (full) {
    for (const [k, r] of nextBase) if (r.calendarUrl === calendarUrl && !liveHrefs.has(r.href)) nextBase.delete(k)
    for (const [k, r] of nextOv) if (r.calendarUrl === calendarUrl && !liveHrefs.has(r.href)) nextOv.delete(k)
  }
  for (const href of deletedHrefs) {
    for (const [k, r] of nextBase) if (r.href === href) nextBase.delete(k)
    for (const [k, r] of nextOv) if (r.href === href) nextOv.delete(k)
  }
  baseEvents.value = nextBase
  overrides.value = nextOv
  bump()
  bumpCalVersion(calendarUrl)
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createEvent(calendarUrl: string, ev: IcsEvent): Promise<EventRecord> {
  const client = requireClient(calendarUrl)
  const data: IcsEvent = { ...ev, uid: ev.uid || newUid() }
  const key = baseKey(data.uid, calendarUrl)
  const rec: EventRecord = {
    key: recordKey(calendarUrl, data.uid),
    calendarUrl,
    href: hrefForEvent(calendarUrl, data.uid),
    etag: '',
    data,
  }
  const snap = snapshot()
  mutate('base', calendarUrl, (m) => m.set(key, rec))
  try {
    const etag = await client.putObject(rec.href, serializeIcsEvent(data))
    retag('base', key, etag)
    void requestSync(calendarUrl)
    return { ...rec, etag }
  } catch (err) {
    failPut(err, calendarUrl, 'create the event', snap)
  }
}

export async function updateEvent(record: EventRecord, patch: EventPatch, scope: EditScope = 'all'): Promise<void> {
  if (scope === 'this' && record.data.recurrenceId) return updateThis(record, patch)
  if (scope === 'future') return updateFuture(record, patch)
  return updateAll(record, patch)
}

async function updateAll(record: EventRecord, patch: EventPatch): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const target = resolveBaseRecord(record)
  const asOverride = target.data.recurrenceId !== undefined
  const key = asOverride
    ? overrideKey(target.data.uid, calendarUrl, target.data.recurrenceId ?? '')
    : baseKey(target.data.uid, calendarUrl)
  const nextData: IcsEvent = { ...target.data, ...patch }
  const snap = snapshot()
  mutate(asOverride ? 'ov' : 'base', calendarUrl, (m) => m.set(key, { ...target, data: nextData }))
  try {
    const body = serializeIcsEvents(groupAtHref(target.href, target.key, nextData))
    const etag = await client.putObject(target.href, body, target.etag)
    retag(asOverride ? 'ov' : 'base', key, etag)
    retagHref('base', target.href, etag)
    retagHref('ov', target.href, etag)
    void requestSync(calendarUrl)
  } catch (err) {
    failPut(err, calendarUrl, 'save the event', snap)
  }
}

async function updateThis(record: EventRecord, patch: EventPatch): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const recId = record.data.recurrenceId ?? ''
  const uid = record.data.uid
  const key = overrideKey(uid, calendarUrl, recId)
  const existing = overrides.value.get(key)
  const snap = snapshot()
  if (existing) {
    const nextData: IcsEvent = { ...existing.data, ...patch }
    mutate('ov', calendarUrl, (m) => m.set(key, { ...existing, data: nextData }))
    try {
      const body = serializeIcsEvents(groupAtHref(existing.href, existing.key, nextData))
      const etag = await client.putObject(existing.href, body, existing.etag)
      retag('ov', key, etag)
      retagHref('base', existing.href, etag)
      retagHref('ov', existing.href, etag)
      void requestSync(calendarUrl)
    } catch (err) {
      failPut(err, calendarUrl, 'save the event', snap)
    }
    return
  }
  const base = baseEvents.value.get(baseKey(uid, calendarUrl))
  if (!base) return updateAll(record, patch) // no series behind it → plain edit
  const ovData: IcsEvent = {
    ...base.data,
    ...patch,
    uid,
    recurrenceId: recId,
    rrule: undefined,
    exdates: [],
    raw: undefined,
  }
  const href = hrefForEvent(calendarUrl, uid, recId)
  mutate('ov', calendarUrl, (m) => m.set(key, { key: recordKey(calendarUrl, uid, recId), calendarUrl, href, etag: '', data: ovData }))
  try {
    const etag = await client.putObject(href, serializeIcsEvent(ovData))
    retag('ov', key, etag)
    void requestSync(calendarUrl)
  } catch (err) {
    failPut(err, calendarUrl, 'save the event', snap)
  }
}

/** The original occurrence time the edit cuts at (RECURRENCE-ID, else start). */
function cutPointOf(record: EventRecord): IcsDate {
  return record.data.recurrenceId ? parseRecId(record.data.recurrenceId) : record.data.start
}

function untilJustBefore(cutInstant: Date, allDay: boolean): Date {
  if (allDay) {
    return new Date(Date.UTC(cutInstant.getUTCFullYear(), cutInstant.getUTCMonth(), cutInstant.getUTCDate() - 1))
  }
  return new Date(cutInstant.getTime() - 1000)
}

/** RRULE for the new series: old rule without UNTIL, COUNT adjusted. */
function rebuiltSeriesRule(baseData: IcsEvent, cut: IcsDate): string {
  const rule = baseData.rrule ?? ''
  const bare = rruleWithoutUntil(rule)
  const count = rruleCount(rule)
  if (count === undefined) return bare
  const before = countOccurrencesBefore(baseData, cut)
  if (before === null) return bare
  return setRruleParam(bare, 'COUNT', String(Math.max(1, count - before)))
}

async function updateFuture(record: EventRecord, patch: EventPatch): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const base = resolveBaseRecord(record)
  const rule = base.data.rrule
  if (!rule) return updateAll(record, patch) // nothing to split
  const cut = cutPointOf(record)
  const cutInstant = icsDateToDate(cut)
  const baseStart = icsDateToDate(base.data.start)
  if (cutInstant.getTime() <= baseStart.getTime()) return updateAll(base, patch)

  const allDay = base.data.allDay
  const durationMs = Math.max(0, icsDateToDate(base.data.end).getTime() - baseStart.getTime())
  const oldData: IcsEvent = { ...base.data, rrule: setRruleUntil(rule, untilJustBefore(cutInstant, allDay), allDay) }

  const seriesUid = newUid()
  const newStart = patch.start ?? mirrorIcsDate(base.data.start, canonicalInstant(cut.utc))
  const newEnd =
    patch.end ?? mirrorIcsDate(base.data.end, new Date(icsDateToDate(newStart).getTime() + durationMs).toISOString())
  const newData: IcsEvent = {
    ...base.data,
    ...patch,
    uid: seriesUid,
    start: newStart,
    end: newEnd,
    rrule: patch.rrule ?? rebuiltSeriesRule(base.data, cut),
    exdates: base.data.exdates.filter((x) => icsDateToDate(x).getTime() >= cutInstant.getTime()),
    recurrenceId: undefined,
    raw: undefined,
  }

  // Overrides at/after the cut move to the new series (uid swap + new files).
  const transfers: { rec: EventRecord; key: string; href: string }[] = []
  for (const r of overrides.value.values()) {
    const rId = r.data.recurrenceId
    if (r.calendarUrl !== calendarUrl || r.data.uid !== base.data.uid || !rId) continue
    if (icsDateToDate(parseRecId(rId)).getTime() < cutInstant.getTime()) continue
    transfers.push({ rec: r, key: overrideKey(seriesUid, calendarUrl, rId), href: hrefForEvent(calendarUrl, seriesUid, rId) })
  }

  const baseK = baseKey(base.data.uid, calendarUrl)
  const newK = baseKey(seriesUid, calendarUrl)
  const snap = snapshot()
  mutate('base', calendarUrl, (m) => {
    m.set(baseK, { ...base, data: oldData })
    m.set(newK, { key: recordKey(calendarUrl, seriesUid), calendarUrl, href: hrefForEvent(calendarUrl, seriesUid), etag: '', data: newData })
  })
  mutate('ov', calendarUrl, (m) => {
    for (const t of transfers) {
      m.delete(overrideKey(base.data.uid, calendarUrl, t.rec.data.recurrenceId ?? ''))
      m.set(t.key, { ...t.rec, href: t.href, etag: '', data: { ...t.rec.data, uid: seriesUid } })
    }
  })
  try {
    const oldEtag = await client.putObject(base.href, serializeIcsEvent(oldData), base.etag)
    retag('base', baseK, oldEtag)
    const newEtag = await client.putObject(hrefForEvent(calendarUrl, seriesUid), serializeIcsEvent(newData))
    retag('base', newK, newEtag)
    for (const t of transfers) {
      const moved = overrides.value.get(t.key)
      if (moved) retag('ov', t.key, await client.putObject(t.href, serializeIcsEvent(moved.data)))
      // Co-located in the master file: the base PUT above already dropped the
      // override VEVENT — deleting again would 412 (or wipe the new master).
      if (t.rec.href !== base.href) await client.deleteObject(t.rec.href, t.rec.etag)
    }
    void requestSync(calendarUrl)
  } catch (err) {
    // A split may be half-applied server-side; always converge via re-sync.
    restore(snap, calendarUrl)
    void requestSync(calendarUrl)
    push('error', failureMessage(err, 'save the series'))
    throw err
  }
}

export async function deleteEvent(record: EventRecord, scope: DeleteScope = 'all'): Promise<void> {
  if (scope === 'this' && record.data.recurrenceId) return deleteOccurrence(record)
  if (scope === 'future') return deleteFuture(record)
  return deleteSeries(record)
}

async function deleteSeries(record: EventRecord): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const base = resolveBaseRecord(record)
  const related = [...overrides.value.values()].filter(
    (r) => r.calendarUrl === calendarUrl && r.data.uid === base.data.uid,
  )
  const snap = snapshot()
  mutate('base', calendarUrl, (m) => m.delete(baseKey(base.data.uid, calendarUrl)))
  mutate('ov', calendarUrl, (m) => {
    for (const r of related) m.delete(overrideKey(base.data.uid, calendarUrl, r.data.recurrenceId ?? ''))
  })
  try {
    await client.deleteObject(base.href, base.etag)
    for (const r of related) await client.deleteObject(r.href, r.etag)
    void requestSync(calendarUrl)
  } catch (err) {
    restore(snap, calendarUrl)
    void requestSync(calendarUrl)
    push('error', failureMessage(err, 'delete the event'))
    throw err
  }
}

async function deleteOccurrence(record: EventRecord): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const recId = record.data.recurrenceId ?? ''
  const uid = record.data.uid
  const base = baseEvents.value.get(baseKey(uid, calendarUrl))
  if (!base) return deleteSeries(record) // orphan exception → drop it
  const override = overrides.value.get(overrideKey(uid, calendarUrl, recId))
  const exdate = mirrorIcsDate(base.data.start, canonicalInstant(parseRecId(recId).utc))
  const nextData: IcsEvent = { ...base.data, exdates: [...base.data.exdates, exdate] }
  const snap = snapshot()
  mutate('base', calendarUrl, (m) => m.set(baseKey(uid, calendarUrl), { ...base, data: nextData }))
  if (override) mutate('ov', calendarUrl, (m) => m.delete(overrideKey(uid, calendarUrl, recId)))
  try {
    const etag = await client.putObject(base.href, serializeIcsEvent(nextData), base.etag)
    retag('base', baseKey(uid, calendarUrl), etag)
    // Co-located in the master file: the base PUT above already added the
    // EXDATE and dropped the override VEVENT — deleting again would 412.
    if (override && override.href !== base.href) await client.deleteObject(override.href, override.etag)
    void requestSync(calendarUrl)
  } catch (err) {
    restore(snap, calendarUrl)
    void requestSync(calendarUrl)
    push('error', failureMessage(err, 'delete the event'))
    throw err
  }
}

async function deleteFuture(record: EventRecord): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const base = resolveBaseRecord(record)
  const rule = base.data.rrule
  if (!rule) return deleteSeries(record)
  const cut = cutPointOf(record)
  const cutInstant = icsDateToDate(cut)
  if (cutInstant.getTime() <= icsDateToDate(base.data.start).getTime()) return deleteSeries(record)
  const nextData: IcsEvent = { ...base.data, rrule: setRruleUntil(rule, untilJustBefore(cutInstant, base.data.allDay), base.data.allDay) }
  const doomed = [...overrides.value.values()].filter(
    (r) =>
      r.calendarUrl === calendarUrl &&
      r.data.uid === base.data.uid &&
      r.data.recurrenceId &&
      icsDateToDate(parseRecId(r.data.recurrenceId)).getTime() >= cutInstant.getTime(),
  )
  const snap = snapshot()
  mutate('base', calendarUrl, (m) => m.set(baseKey(base.data.uid, calendarUrl), { ...base, data: nextData }))
  mutate('ov', calendarUrl, (m) => {
    for (const r of doomed) m.delete(overrideKey(base.data.uid, calendarUrl, r.data.recurrenceId ?? ''))
  })
  try {
    const etag = await client.putObject(base.href, serializeIcsEvent(nextData), base.etag)
    retag('base', baseKey(base.data.uid, calendarUrl), etag)
    for (const r of doomed) {
      // Co-located in the master file: the base PUT above already dropped it.
      if (r.href === base.href) continue
      await client.deleteObject(r.href, r.etag)
    }
    void requestSync(calendarUrl)
  } catch (err) {
    restore(snap, calendarUrl)
    void requestSync(calendarUrl)
    push('error', failureMessage(err, 'delete the series'))
    throw err
  }
}

// ---------------------------------------------------------------------------
// Undo (design §5 toast action)
// ---------------------------------------------------------------------------

/**
 * Undo payload for a destructive event delete: the exact ICS body serialized
 * before the DELETE, the calendar it lived in, the original object href, the
 * uid, and the parsed data used to re-adopt the restored record without
 * waiting for the sync.
 */
export interface EventDeleteUndo {
  calendarUrl: string
  uid: string
  /** Href the object lived at before the delete (seeded files may not match
   * the uid-derived href); empty only for never-synced local records. */
  href: string
  body: string
  data: IcsEvent
}

/**
 * Restore one deleted event: PUT the captured body back to the original href
 * with If-None-Match:* (create-only, same as createEvent) and adopt it via
 * applyCollectionSync. 412 → the object already exists server-side; error
 * toast + re-sync so the store converges to server truth.
 */
export async function restoreEvent(undo: EventDeleteUndo): Promise<void> {
  let client: CaldavClient
  try {
    client = requireClient(undo.calendarUrl)
  } catch {
    return // requireClient already toasted
  }
  // The deleted object's exact href, so the original filename (and its UID
  // slot) is recreated; uid-derived href only as a never-synced fallback.
  const href = undo.href || hrefForEvent(undo.calendarUrl, undo.uid)
  try {
    const etag = await client.putObject(href, undo.body)
    applyCollectionSync(undo.calendarUrl, [{ href, etag, events: [undo.data], todos: [] }], [], false)
    void requestSync(undo.calendarUrl)
    push('success', 'Event restored')
  } catch (err) {
    if (httpStatus(err) === 412) {
      push('error', 'Could not restore — event already exists')
      void requestSync(undo.calendarUrl)
      return
    }
    push('error', failureMessage(err, 'restore the event'))
  }
}
