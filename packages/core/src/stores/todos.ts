/**
 * Todo store (CONTRACTS §12): `todos` signal Map<`uid@cal`, TodoRecord> plus a
 * `revision` counter bumped on every mutation (memo key for view selectors).
 * CRUD is optimistic with snapshot-rollback + toast on failure — the same
 * pattern as events.ts; per the Radicale error law a 412 (stale If-Match)
 * additionally re-syncs the collection so the store converges to server
 * truth. Every successful mutation fires `requestSync(calendarUrl)`.
 *
 * VTODOs are flat here (no occurrence expansion): TasksView (§15) renders the
 * stored records; hierarchy is the `relatedTo` parent link via `childrenOf`.
 */
import { signal } from '@preact/signals-core'
import type { CaldavClient } from '../lib/caldav/client'
import type { IcsDate, IcsTodo } from '../lib/ics/types'
import { icsDateToDate } from '../lib/ics/types'
import { serializeIcsTodo } from '../lib/ics/serialize'
import { clientForCollection, httpStatus, requestSync } from '../lib/sync/engine'
import { newUid } from '../lib/util/id'
import { isCalendarVisible } from './calendars'
import { push } from './toasts'

export interface TodoRecord {
  /** `calendarUrl + '/' + uid`. */
  key: string
  calendarUrl: string
  href: string
  etag: string
  data: IcsTodo
}

export type TodoPatch = Partial<Omit<IcsTodo, 'uid' | 'raw'>>
/** One fetched calendar object, already parsed into its VTODOs. */
interface ParsedTodoObject {
  href: string
  etag: string
  todos: IcsTodo[]
}

export const todos = signal<Map<string, TodoRecord>>(new Map())
export const revision = signal(0)

/** Map key for a todo: `uid@calendarUrl` (mirrors the events store). */
export function todoKey(uid: string, calendarUrl: string): string {
  return `${uid}@${calendarUrl}`
}

function recordKey(calendarUrl: string, uid: string): string {
  return `${calendarUrl}/${uid}`
}

/** Object href on the server: `<calendar>/<uid>.ics`. */
function hrefForTodo(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/+$/, '')}/${uid}.ics`
}

interface TodosSnapshot {
  map: Map<string, TodoRecord>
}

function bump(): void {
  revision.value++
}

function snapshot(): TodosSnapshot {
  return { map: todos.value }
}

/** Signals need fresh Map identities; restore + bump re-notifies watchers. */
function restore(snap: TodosSnapshot): void {
  todos.value = snap.map
  bump()
}

function mutate(fn: (m: Map<string, TodoRecord>) => void): void {
  const next = new Map(todos.value)
  fn(next)
  todos.value = next
  bump()
}

/** Update just an etag after a PUT (no content change → no revision bump). */
function retag(key: string, etag: string): void {
  const prev = todos.value.get(key)
  if (!prev || prev.etag === etag) return
  const next = new Map(todos.value)
  next.set(key, { ...prev, etag })
  todos.value = next
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
  if (status === 412) return 'This task changed on the server — reloading the latest version'
  if (status === 401 || status === 403) return 'Server rejected the change (permission denied)'
  const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
  return `Could not ${action}${detail}`
}

/** Rollback + toast + (412 → per error law) collection re-sync; rethrows. */
function failPut(err: unknown, calendarUrl: string, action: string, snap: TodosSnapshot): never {
  restore(snap)
  if (httpStatus(err) === 412) void requestSync(calendarUrl)
  push('error', failureMessage(err, action))
  throw err
}

// ---------------------------------------------------------------------------
// Engine feed (whole-collection sync apply; one revision bump per batch)
// ---------------------------------------------------------------------------

export function applyTodoCollectionSync(
  calendarUrl: string,
  objs: ParsedTodoObject[],
  deletedHrefs: string[],
  full: boolean,
): void {
  const next = new Map(todos.value)
  let touched = false
  const liveHrefs = new Set<string>()
  for (const o of objs) {
    liveHrefs.add(o.href)
    for (const td of o.todos) {
      if (!td.uid) continue
      next.set(todoKey(td.uid, calendarUrl), {
        key: recordKey(calendarUrl, td.uid),
        calendarUrl,
        href: o.href,
        etag: o.etag,
        data: td,
      })
      touched = true
    }
  }
  if (full) {
    for (const [k, r] of next) {
      if (r.calendarUrl === calendarUrl && !liveHrefs.has(r.href)) {
        next.delete(k)
        touched = true
      }
    }
  }
  for (const href of deletedHrefs) {
    for (const [k, r] of next) {
      if (r.href === href) {
        next.delete(k)
        touched = true
      }
    }
  }
  if (!touched) return
  todos.value = next
  bump()
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createTodo(calendarUrl: string, todo: IcsTodo): Promise<TodoRecord> {
  const client = requireClient(calendarUrl)
  const data: IcsTodo = { ...todo, uid: todo.uid || newUid() }
  const key = todoKey(data.uid, calendarUrl)
  const rec: TodoRecord = {
    key: recordKey(calendarUrl, data.uid),
    calendarUrl,
    href: hrefForTodo(calendarUrl, data.uid),
    etag: '',
    data,
  }
  const snap = snapshot()
  mutate((m) => m.set(key, rec))
  try {
    const etag = await client.putObject(rec.href, serializeIcsTodo(data))
    retag(key, etag)
    void requestSync(calendarUrl)
    return { ...rec, etag }
  } catch (err) {
    failPut(err, calendarUrl, 'create the task', snap)
  }
}

/**
 * Serializes mutations per todo key: rapid quick-action clicks must not race
 * PUTs built from stale closure records/etags. Each chained task starts only
 * after every earlier mutation for that key settled (success or failure —
 * failures never block the chain) and re-reads the record from the store at
 * run time. The map value is a sanitized tail (never rejects); the entry is
 * deleted once it settles with nothing newer chained onto it.
 */
const todoMutations = new Map<string, Promise<void>>()

function chainTodoMutation(
  key: string,
  run: (isTail: () => boolean) => Promise<void>,
): Promise<void> {
  const prev = todoMutations.get(key) ?? Promise.resolve()
  // isTail: no newer mutation has been queued for this key — rollback paths
  // must check it or they would clobber newer optimistic state. `tail` is
  // assigned before any run() executes (then() defers to a microtask).
  const task: Promise<void> = prev.then(() => run(() => todoMutations.get(key) === tail))
  const tail: Promise<void> = task.then(
    () => {},
    () => {},
  )
  todoMutations.set(key, tail)
  void tail.then(() => {
    if (todoMutations.get(key) === tail) todoMutations.delete(key)
  })
  return task
}

export async function updateTodo(record: TodoRecord, patch: TodoPatch): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const key = todoKey(record.data.uid, calendarUrl)
  return chainTodoMutation(key, async (isTail) => {
    // Re-resolve at run time: the caller's record may be stale by now — an
    // earlier chained mutation rewrote this record's etag and data.
    const current = todos.value.get(key) ?? record
    const nextData: IcsTodo = { ...current.data, ...patch }
    const snap = snapshot()
    mutate((m) => m.set(key, { ...current, data: nextData }))
    try {
      const etag = await client.putObject(current.href, serializeIcsTodo(nextData), current.etag)
      retag(key, etag)
      void requestSync(calendarUrl)
    } catch (err) {
      if (isTail()) failPut(err, calendarUrl, 'save the task', snap)
      // Superseded: a newer mutation owns this record — skip the rollback
      // write (the newer mutation's success publishes the correct state)
      // and just re-sync.
      void requestSync(calendarUrl)
    }
  })
}

export async function deleteTodo(record: TodoRecord): Promise<void> {
  const calendarUrl = record.calendarUrl
  const client = requireClient(calendarUrl)
  const key = todoKey(record.data.uid, calendarUrl)
  return chainTodoMutation(key, async (isTail) => {
    // Re-resolve at run time: an earlier chained mutation may have rewritten
    // this record's etag/data — or already deleted it.
    const current = todos.value.get(key)
    if (!current) return // deleted by an earlier chained mutation; nothing to DELETE
    // Captured before the delete so the undo toast can re-create the task at
    // its original href (seeded filenames may differ from the uid-derived one).
    const undo: TodoDeleteUndo = {
      calendarUrl,
      uid: current.data.uid,
      href: current.href,
      body: serializeIcsTodo(current.data),
      data: current.data,
    }
    const snap = snapshot()
    mutate((m) => m.delete(key))
    try {
      await client.deleteObject(current.href, current.etag)
      void requestSync(calendarUrl)
      push('info', 'Task deleted', { label: 'Undo', run: () => restoreTodo(undo) })
    } catch (err) {
      if (isTail()) {
        restore(snap)
        if (httpStatus(err) === 412) void requestSync(calendarUrl)
        push('error', failureMessage(err, 'delete the task'))
        throw err
      }
      // Superseded: a newer mutation owns this record — skip the rollback
      // write (it would resurrect a task the newer mutation supersedes)
      // and just re-sync.
      void requestSync(calendarUrl)
    }
  })
}

/**
 * Undo payload for a destructive task delete: the exact ICS body serialized
 * before the DELETE, the calendar it lived in, the original object href, the
 * uid, and the parsed data used to re-adopt the restored record without
 * waiting for the sync.
 */
interface TodoDeleteUndo {
  calendarUrl: string
  uid: string
  /** Href the object lived at before the delete; empty only for never-synced
   * local records. */
  href: string
  body: string
  data: IcsTodo
}

/**
 * Restore one deleted task (design §5 toast action): PUT the captured body
 * back to the original href with If-None-Match:* (create-only, same as
 * createTodo) and adopt it via applyTodoCollectionSync. 412 → the object
 * already exists server-side; error toast + re-sync so the store converges.
 */
async function restoreTodo(undo: TodoDeleteUndo): Promise<void> {
  let client: CaldavClient
  try {
    client = requireClient(undo.calendarUrl)
  } catch {
    return // requireClient already toasted
  }
  // The deleted object's exact href, so the original filename (and its UID
  // slot) is recreated; uid-derived href only as a never-synced fallback.
  const href = undo.href || hrefForTodo(undo.calendarUrl, undo.uid)
  try {
    const etag = await client.putObject(href, undo.body)
    applyTodoCollectionSync(undo.calendarUrl, [{ href, etag, todos: [undo.data] }], [], false)
    void requestSync(undo.calendarUrl)
    push('success', 'Task restored')
  } catch (err) {
    if (httpStatus(err) === 412) {
      push('error', 'Could not restore — task already exists')
      void requestSync(undo.calendarUrl)
      return
    }
    push('error', failureMessage(err, 'restore the task'))
  }
}

/**
 * STATUS NEEDS-ACTION ↔ COMPLETED, COMPLETED timestamp now ↔ none,
 * PERCENT-COMPLETE 100 ↔ none. Anything not COMPLETED (including CANCELLED)
 * counts as open and flips to COMPLETED.
 */
export function toggleDone(record: TodoRecord): Promise<void> {
  const done = isTodoDone(record.data)
  const patch: TodoPatch = done
    ? { status: 'NEEDS-ACTION', completed: undefined, percentComplete: undefined }
    : { status: 'COMPLETED', completed: { utc: new Date().toISOString() }, percentComplete: 100 }
  return updateTodo(record, patch)
}

/**
 * Quick-action status cycle (§22 todo popover): TODO → IN-PROCESS →
 * COMPLETED → TODO. Entering COMPLETED mirrors toggleDone's write (COMPLETED
 * timestamp now, PERCENT-COMPLETE 100); leaving it clears both, per the
 * toggleDone round-trip. Anything not COMPLETED/IN-PROCESS (e.g. CANCELLED)
 * counts as TODO and flips to IN-PROCESS. Same updateTodo PUT/If-Match path
 * (and rollback/error toasts) as every other patch.
 */
export function cycleTodoStatus(record: TodoRecord): Promise<void> {
  const patch: TodoPatch = isTodoDone(record.data)
    ? { status: 'NEEDS-ACTION', completed: undefined, percentComplete: undefined }
    : record.data.status === 'IN-PROCESS'
      ? { status: 'COMPLETED', completed: { utc: new Date().toISOString() }, percentComplete: 100 }
      : { status: 'IN-PROCESS', completed: undefined, percentComplete: undefined }
  return updateTodo(record, patch)
}

/** Quick-action priority write: the #A/#B/#C band values (1/4/7) or none. */
export function setTodoPriority(record: TodoRecord, priority: 1 | 4 | 7 | undefined): Promise<void> {
  return updateTodo(record, { priority })
}

/** Quick-action due write: a new IcsDate (form class decided by the caller) or none. */
export function setTodoDue(record: TodoRecord, due: IcsDate | undefined): Promise<void> {
  return updateTodo(record, { due })
}

// ---------------------------------------------------------------------------
// Selectors (§12 fixed definitions — do not reinterpret)
// ---------------------------------------------------------------------------

/** org done-parity: STATUS:COMPLETED (what toggleDone writes back and forth). */
export function isTodoDone(td: IcsTodo): boolean {
  return td.status === 'COMPLETED'
}

/** Direct children of `parentUid` via RELATED-TO, optionally scoped to one calendar. */
export function childrenOf(parentUid: string, calendarUrl?: string): TodoRecord[] {
  const out: TodoRecord[] = []
  for (const rec of todos.value.values()) {
    if (rec.data.relatedTo !== parentUid) continue
    if (calendarUrl !== undefined && rec.calendarUrl !== calendarUrl) continue
    out.push(rec)
  }
  return out
}

const DAY_MS = 24 * 60 * 60 * 1000

function hasDateWithinNextDays(td: IcsTodo, fromMs: number, untilMs: number): boolean {
  for (const d of [td.due, td.dtstart]) {
    if (!d) continue
    const ms = icsDateToDate(d).getTime()
    if (ms >= fromMs && ms <= untilMs) return true
  }
  return false
}

/**
 * Incomplete, top-level (no RELATED-TO), stuck-projects approximation
 * (CONTRACTS §12, fixed law): no incomplete children, and no dtstart/due
 * within the next 7 days. Schedule-domain visible calendars only (its
 * consumer is the search corpus); reads `todos`, `revision` and the calendars
 * visibility signals, so callers tracking signals re-run when any of them
 * change.
 */
export function stuckTopLevel(): TodoRecord[] {
  const now = Date.now()
  const horizon = now + 7 * DAY_MS
  const out: TodoRecord[] = []
  for (const rec of todos.value.values()) {
    if (!isCalendarVisible(rec.calendarUrl, 'schedule')) continue
    const td = rec.data
    if (isTodoDone(td)) continue
    if (td.relatedTo) continue
    if (childrenOf(td.uid).some((k) => !isTodoDone(k.data))) continue
    if (hasDateWithinNextDays(td, now, horizon)) continue
    out.push(rec)
  }
  return out
}

// ---------------------------------------------------------------------------
// Offline snapshot (CONTRACTS §36 mobile boot)
// ---------------------------------------------------------------------------

function isTodoRecord(v: unknown): v is TodoRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (
    typeof r.key !== 'string' ||
    typeof r.calendarUrl !== 'string' ||
    typeof r.href !== 'string' ||
    typeof r.etag !== 'string' ||
    typeof r.data !== 'object' ||
    r.data === null
  ) {
    return false
  }
  const d = r.data as Record<string, unknown>
  return typeof d.uid === 'string' && typeof d.summary === 'string'
}

/** JSON entry-array (`[key, record][]`) → Map; null when any entry is malformed. */
function entriesToTodoMap(v: unknown): Map<string, TodoRecord> | null {
  if (!Array.isArray(v)) return null
  const out = new Map<string, TodoRecord>()
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !isTodoRecord(e[1])) return null
    out.set(e[0], e[1])
  }
  return out
}

/**
 * Snapshot = the todo Map as a JSON entry array plus the revision counter.
 * Records carry hrefs/etags so the next sync delta-applies against restored
 * state. The per-key mutation chains are transient — not carried.
 */
export function serializeSnapshot(): unknown {
  return {
    todos: [...todos.value.entries()],
    revision: revision.value,
  }
}

/**
 * Restore records. Pure memory restore — no writes, toasts, or network; the
 * signal gets a fresh Map identity so watchers re-run. Malformed input is a
 * no-op (fresh-boot semantics).
 */
export function hydrateSnapshot(snap: unknown): void {
  try {
    if (typeof snap !== 'object' || snap === null) return
    const s = snap as { todos?: unknown; revision?: unknown }
    const map = entriesToTodoMap(s.todos)
    if (!map) return
    todos.value = map
    if (typeof s.revision === 'number' && Number.isFinite(s.revision) && s.revision >= 0) {
      revision.value = Math.max(revision.value, s.revision)
    }
  } catch {
    // Malformed snapshot → leave the store as-is (fresh-boot semantics).
  }
}
