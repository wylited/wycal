/**
 * Saved composite views (CONTRACTS §12): named stacks of agenda / todo /
 * search sections, persisted to localStorage 'wycal.savedviews'. Pure store —
 * the `#/calendar?saved=<id>` route renders them (CONTRACTS §15).
 */
import { signal } from '@preact/signals'
import { dayKey } from '@wycal/core/lib/util/date'
import { applyVisibility, collections, isCalendarVisible } from '@wycal/core/stores/calendars'
import { newUid } from '@wycal/core/lib/util/id'
import { prefs, setPrefs } from '@wycal/core/stores/prefs'

export type SavedSection =
  | { type: 'agenda'; days: number; calendars?: string[] }
  | {
      type: 'todos'
      filter: { status?: 'all' | 'open' | 'done' | 'stuck'; tag?: string; calendar?: string }
    }
  | { type: 'match'; query: string }

export interface SavedView {
  id: string
  name: string
  sections: SavedSection[]
}

/** saveView input: full view; `id` present → replace in place. */
type SavedViewInput = Omit<SavedView, 'id'> & { id?: string }

const SAVEDVIEWS_STORAGE_KEY = 'wycal.savedviews'

/** Structural load guard: keep only view-shaped entries, drop the rest. */
function loadSavedViews(): SavedView[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(SAVEDVIEWS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: SavedView[] = []
    for (const v of parsed) {
      if (typeof v !== 'object' || v === null) continue
      const r = v as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.sections)) continue
      out.push({ id: r.id, name: r.name, sections: r.sections as SavedSection[] })
    }
    return out
  } catch (err) {
    console.warn('wycal: could not read saved views, using none', err)
    return []
  }
}

/** All saved views, persisted to 'wycal.savedviews'. */
export const savedViews = signal<SavedView[]>(loadSavedViews())

function persist(): void {
  try {
    localStorage.setItem(SAVEDVIEWS_STORAGE_KEY, JSON.stringify(savedViews.value))
  } catch (err) {
    console.warn('wycal: could not persist saved views', err)
  }
}

/** Insert (or update, when `input.id` exists) and persist; returns the stored view. */
export function saveView(input: SavedViewInput): SavedView {
  const view: SavedView = { id: input.id ?? newUid(), name: input.name, sections: input.sections }
  const exists = savedViews.value.some((v) => v.id === view.id)
  savedViews.value = exists
    ? savedViews.value.map((v) => (v.id === view.id ? view : v))
    : [...savedViews.value, view]
  persist()
  return view
}

/** Drop a saved view (no-op when the id is unknown). */
export function deleteView(id: string): void {
  savedViews.value = savedViews.value.filter((v) => v.id !== id)
  persist()
}

// ---------------------------------------------------------------------------
// Saved views V2 (calendar context): visibility + view + n + todos toggle.
// A separate model under 'wycal.savedviews2'; V1 composites above are untouched.
// ---------------------------------------------------------------------------

/** Calendar-view names a V2 view restores (`ndays` = timeGrid with `n` days). */
type SavedViewV2Name = 'day' | '3d' | '5d' | 'week' | '2week' | 'month' | 'agenda' | 'ndays'

interface SavedViewV2 {
  id: string
  name: string
  /** Single printable key that applies the view (CONTRACTS §16-safe; optional). */
  keybind?: string
  /** Visible calendar URLs captured at save time; EMPTY = all calendars
   * visible (never "hide everything"). */
  visibility: string[]
  view: SavedViewV2Name
  /** Day count for N-day views (3d/5d presets pin their preset count). */
  n?: number
  /** Whether the calendar's agenda-todos toggle was on when saved. */
  includeTodos: boolean
}

const SAVEDVIEWS_V2_STORAGE_KEY = 'wycal.savedviews2'

const V2_VIEW_NAMES: Record<string, true> = {
  day: true, '3d': true, '5d': true, week: true, '2week': true, month: true, agenda: true, ndays: true,
}

/** Structural load guard: keep only V2-shaped entries, drop the rest. */
function loadSavedViewsV2(): SavedViewV2[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(SAVEDVIEWS_V2_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: SavedViewV2[] = []
    for (const v of parsed) {
      if (typeof v !== 'object' || v === null) continue
      const r = v as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue
      if (!Array.isArray(r.visibility) || r.visibility.some((u) => typeof u !== 'string')) continue
      if (typeof r.view !== 'string' || !V2_VIEW_NAMES[r.view]) continue
      if (typeof r.includeTodos !== 'boolean') continue
      const n = r.n
      if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 14)) continue
      out.push({
        id: r.id,
        name: r.name,
        keybind: typeof r.keybind === 'string' && r.keybind.length > 0 ? r.keybind : undefined,
        visibility: r.visibility as string[],
        view: r.view as SavedViewV2Name,
        n,
        includeTodos: r.includeTodos,
      })
    }
    return out
  } catch (err) {
    console.warn('wycal: could not read saved views v2, using none', err)
    return []
  }
}

/** All V2 saved views, persisted to 'wycal.savedviews2'. */
export const savedViewsV2 = signal<SavedViewV2[]>(loadSavedViewsV2())

function persistV2(): void {
  try {
    localStorage.setItem(SAVEDVIEWS_V2_STORAGE_KEY, JSON.stringify(savedViewsV2.value))
  } catch (err) {
    console.warn('wycal: could not persist saved views v2', err)
  }
}

/** First-run seed ("default 5 day saved view"): when 'wycal.savedviews2' is
 * COMPLETELY empty, insert one Work-week view so a fresh install has a 5-day
 * saved view out of the box. Users with any views — including one that merely
 * deleted this default — are never touched. `visibility: []` = all calendars
 * visible (see applyView). */
function ensureDefaultViews(): void {
  if (savedViewsV2.value.length > 0) return
  savedViewsV2.value = [
    { id: 'sv-workweek', name: 'Work week (5 days)', visibility: [], view: '5d', n: 5, includeTodos: true },
  ]
  persistV2()
}
ensureDefaultViews()

// View names as written to the calendar hash (`#/?view=…`); '2weeks' vs the
// model's '2week' and 'ndays' (rendered as a 3d/5d-preset timeGrid with `n`).
const HASH_VIEW_NAMES: Record<string, true> = {
  day: true, '3d': true, '5d': true, week: true, '2weeks': true, month: true, agenda: true,
}
const FC_TO_V2: Record<string, SavedViewV2Name> = {
  timeGridDay: 'day',
  timeGridNDays: 'ndays',
  timeGridWeek: 'week',
  dayGridTwoWeeks: '2week', // §w13: 2weeks became a dayGrid view
  timeGridTwoWeeks: '2week', // stale stored defaultViews still resolve
  dayGridMonth: 'month',
  listAgenda: 'agenda',
}
const V2_TO_HASH: Record<SavedViewV2Name, string> = {
  day: 'day', '3d': '3d', '5d': '5d', week: 'week', '2week': '2weeks',
  month: 'month', agenda: 'agenda', ndays: '3d',
}

/** prefs.defaultView (FullCalendar or hash name) → V2 view name. */
function defaultViewName(): SavedViewV2Name {
  const pref = prefs.value.defaultView
  if (HASH_VIEW_NAMES[pref]) return (pref === '2weeks' ? '2week' : pref) as SavedViewV2Name
  return FC_TO_V2[pref] ?? 'week'
}

/** Current view+n+todos from the calendar hash (the persisted view state;
 * the date is deliberately never captured — applying lands on today). */
function captureCurrentView(): { view: SavedViewV2Name; n?: number; includeTodos: boolean } {
  const hash = typeof location === 'undefined' ? '' : location.hash
  const qi = hash.indexOf('?')
  const params = new URLSearchParams(qi === -1 ? '' : hash.slice(qi + 1))
  const raw = params.get('view')
  const hashView = raw !== null && HASH_VIEW_NAMES[raw] ? raw : defaultViewName()
  if (hashView === '3d' || hashView === '5d') {
    // Presets may carry a custom duration in the hash (`view=3d&n=7`).
    const rawN = Number(params.get('n'))
    const n = Number.isInteger(rawN) && rawN >= 1 && rawN <= 14 ? rawN : hashView === '3d' ? 3 : 5
    return { view: hashView, n, includeTodos: false }
  }
  const view: SavedViewV2Name = hashView === '2weeks' ? '2week' : (hashView as SavedViewV2Name)
  return { view, n: undefined, includeTodos: view === 'agenda' }
}

/** Capture the CURRENT schedule-domain calendar visibility + view + n + todos
 * toggle (never the date) as a new V2 view. `name` trims to a label,
 * defaulting to "View <count>". */
export function saveCurrentView(name?: string): SavedViewV2 {
  const { view, n, includeTodos } = captureCurrentView()
  const visibility = collections.value
    .filter((c) => c.kind === 'calendar' && isCalendarVisible(c.url, 'schedule'))
    .map((c) => c.url)
  const saved: SavedViewV2 = {
    id: newUid(),
    name: name?.trim() || `View ${savedViewsV2.value.length + 1}`,
    visibility,
    view,
    ...(n !== undefined ? { n } : {}),
    includeTodos,
  }
  savedViewsV2.value = [...savedViewsV2.value, saved]
  persistV2()
  return saved
}

/** Restore a V2 view: visibility first (an EMPTY visibility list means all
 * calendars visible), then the calendar route at `view`
 * (plus `n` when it differs from the preset) with date = today. */
export function applyView(id: string): SavedViewV2 | null {
  const v = savedViewsV2.value.find((sv) => sv.id === id)
  if (!v) return null
  // `applyVisibility` hides everything absent from its set, so a bare
  // `new Set([])` would blind the calendar; empty = all calendars visible.
  // V2 views restore the SCHEDULE domain (they are schedule-mode views).
  const visible =
    v.visibility.length === 0
      ? new Set(collections.value.filter((c) => c.kind === 'calendar').map((c) => c.url))
      : new Set(v.visibility)
  applyVisibility('schedule', visible)
  const params = new URLSearchParams()
  params.set('view', V2_TO_HASH[v.view])
  const preset = v.view === '3d' ? 3 : v.view === '5d' ? 5 : null
  const n = v.view === 'ndays' ? (v.n ?? 3) : v.n
  if (n !== undefined && n !== preset) params.set('n', String(n))
  params.set('date', dayKey(new Date()))
  location.hash = `/?${params.toString()}`
  return v
}

/** Rename a V2 view (no-op on an empty name; returns true when changed). */
export function renameViewV2(id: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const exists = savedViewsV2.value.some((v) => v.id === id)
  if (!exists) return false
  savedViewsV2.value = savedViewsV2.value.map((v) => (v.id === id ? { ...v, name: trimmed } : v))
  persistV2()
  return true
}

/** Set (or clear with an empty/undefined key) a V2 view's keybind. */
export function setViewKeybind(id: string, keybind?: string): void {
  const key = keybind?.trim() || undefined
  savedViewsV2.value = savedViewsV2.value.map((v) =>
    v.id === id ? { ...v, keybind: key } : v,
  )
  persistV2()
}

/** Drop a V2 saved view (no-op when the id is unknown). */
export function deleteViewV2(id: string): void {
  savedViewsV2.value = savedViewsV2.value.filter((v) => v.id !== id)
  persistV2()
}

// CONTRACTS §16 keys the global/calendar handlers already own: modifier-free
// globals (both letter cases), the calendar keys, period/step punctuation and
// the 1–9 calendar-visibility row.
const RESERVED_KEYBIND_CHARS: Record<string, true> = { '/': true, '?': true, ',': true, '.': true, '+': true, '-': true }
const RESERVED_KEYBIND_LETTERS: Record<string, true> = {
  n: true, c: true, s: true, x: true, q: true, d: true, w: true, m: true, a: true, t: true,
}

/** True when `key` cannot become a saved-view keybind: not a single printable
 * character, reserved by §16, or already bound to another view (V2 schedule
 * OR agenda — a keybind must resolve to exactly one view per mode). */
export function keybindConflict(key: string, selfId?: string): boolean {
  if (key.length !== 1 || /\s/.test(key)) return true
  if (key >= '1' && key <= '9') return true
  if (RESERVED_KEYBIND_CHARS[key]) return true
  if (RESERVED_KEYBIND_LETTERS[key.toLowerCase()]) return true
  return (
    savedViewsV2.value.some((v) => v.keybind === key && v.id !== selfId) ||
    savedAgendaViews.value.some((v) => v.keybind === key && v.id !== selfId)
  )
}

// ---------------------------------------------------------------------------
// Agenda saved views (§nav-revamp): a SEPARATE list under 'wycal.agendaviews'.
// Same inline save/rename/keybind UI as the V2 schedule views, but the shape
// captures agenda-mode prefs: group + events/todos toggles + todo filters.
// Applying writes those prefs (the agenda hash `#/?view=agenda` is left
// untouched — the sidebar section is only reachable from agenda mode).
// ---------------------------------------------------------------------------

/** Agenda todo STATUS bands a saved view can capture. */
export type AgendaSavedStatusFilter = 'all' | 'todo' | 'doing' | 'done'
/** Agenda todo PRIORITY bands a saved view can capture. */
export type AgendaSavedPriorityFilter = 'all' | 'A' | 'B' | 'C'

export interface AgendaSavedView {
  id: string
  name: string
  /** Single printable key that applies the view (§16-reserved keys rejected). */
  keybind?: string
  /** Agenda grouping chip ('flat' captures as 'day'). */
  group: 'day' | 'calendar'
  /** Show todo rows (prefs.agendaTodos). */
  todos: boolean
  /** Show event rows (prefs.agendaEvents). */
  events: boolean
  /** Todo status chip; absent → 'all'. */
  statusFilter?: AgendaSavedStatusFilter
  /** Todo priority chip; absent → 'all'. */
  priorityFilter?: AgendaSavedPriorityFilter
}

const AGENDAVIEWS_STORAGE_KEY = 'wycal.agendaviews'

const AGENDA_STATUS_VALUES: Record<string, true> = {
  all: true, todo: true, doing: true, done: true,
}
const AGENDA_PRIORITY_VALUES: Record<string, true> = { all: true, A: true, B: true, C: true }

/** Structural load guard: keep only agenda-view-shaped entries, drop the rest. */
function loadSavedAgendaViews(): AgendaSavedView[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(AGENDAVIEWS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: AgendaSavedView[] = []
    for (const r of parsed as Array<Record<string, unknown>>) {
      if (typeof r !== 'object' || r === null) continue
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue
      if ((r.group !== 'day' && r.group !== 'calendar') || typeof r.todos !== 'boolean' || typeof r.events !== 'boolean') continue
      out.push({
        id: r.id,
        name: r.name,
        keybind: typeof r.keybind === 'string' && r.keybind.length > 0 ? r.keybind : undefined,
        group: r.group,
        todos: r.todos,
        events: r.events,
        statusFilter:
          typeof r.statusFilter === 'string' && AGENDA_STATUS_VALUES[r.statusFilter]
            ? (r.statusFilter as AgendaSavedStatusFilter)
            : undefined,
        priorityFilter:
          typeof r.priorityFilter === 'string' && AGENDA_PRIORITY_VALUES[r.priorityFilter]
            ? (r.priorityFilter as AgendaSavedPriorityFilter)
            : undefined,
      })
    }
    return out
  } catch (err) {
    console.warn('wycal: could not read agenda saved views, using none', err)
    return []
  }
}

/** All agenda saved views, persisted to 'wycal.agendaviews'. */
export const savedAgendaViews = signal<AgendaSavedView[]>(loadSavedAgendaViews())

function persistAgendaViews(): void {
  try {
    localStorage.setItem(AGENDAVIEWS_STORAGE_KEY, JSON.stringify(savedAgendaViews.value))
  } catch (err) {
    console.warn('wycal: could not persist agenda saved views', err)
  }
}

/** Capture the CURRENT agenda prefs (group, events/todos toggles, todo
 * filters — never the tags selection) as a new agenda view. `name` trims to a
 * label, defaulting to "View <count>". */
export function saveCurrentAgendaView(name?: string): AgendaSavedView {
  const p = prefs.value
  const saved: AgendaSavedView = {
    id: newUid(),
    name: name?.trim() || `View ${savedAgendaViews.value.length + 1}`,
    group: p.agendaGroup === 'calendar' ? 'calendar' : 'day',
    todos: p.agendaTodos ?? true,
    events: p.agendaEvents ?? true,
    statusFilter: p.agendaStatusFilter ?? 'all',
    priorityFilter: p.agendaPriorityFilter ?? 'all',
  }
  savedAgendaViews.value = [...savedAgendaViews.value, saved]
  persistAgendaViews()
  return saved
}

/** Apply an agenda view: write its group/toggles/filters back into prefs.
 * The agenda tag selection (agendaFilters.tags) is deliberately untouched. */
export function applyAgendaView(id: string): AgendaSavedView | null {
  const v = savedAgendaViews.value.find((sv) => sv.id === id)
  if (!v) return null
  setPrefs({
    agendaGroup: v.group,
    agendaTodos: v.todos,
    agendaEvents: v.events,
    agendaStatusFilter: v.statusFilter ?? 'all',
    agendaPriorityFilter: v.priorityFilter ?? 'all',
  })
  return v
}

/** Rename an agenda view (no-op on an empty name; returns true when changed). */
export function renameAgendaView(id: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const exists = savedAgendaViews.value.some((v) => v.id === id)
  if (!exists) return false
  savedAgendaViews.value = savedAgendaViews.value.map((v) => (v.id === id ? { ...v, name: trimmed } : v))
  persistAgendaViews()
  return true
}

/** Set (or clear with an empty/undefined key) an agenda view's keybind. */
export function setAgendaViewKeybind(id: string, keybind?: string): void {
  const key = keybind?.trim() || undefined
  savedAgendaViews.value = savedAgendaViews.value.map((v) =>
    v.id === id ? { ...v, keybind: key } : v,
  )
  persistAgendaViews()
}

/** Drop an agenda saved view (no-op when the id is unknown). */
export function deleteAgendaView(id: string): void {
  savedAgendaViews.value = savedAgendaViews.value.filter((v) => v.id !== id)
  persistAgendaViews()
}
