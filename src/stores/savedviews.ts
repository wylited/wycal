/**
 * Saved composite views (CONTRACTS §12): named stacks of agenda / todo /
 * search sections, persisted to localStorage 'wycal.savedviews'. Pure store —
 * the `#/calendar?saved=<id>` route renders them (CONTRACTS §15).
 */
import { signal } from '@preact/signals'
import { dayKey } from '../lib/util/date'
import { collections, isCalendarVisible, setVisibility } from './calendars'
import { newUid } from '../lib/util/id'
import { prefs } from './prefs'

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
  timeGridTwoWeeks: '2week',
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

/** Capture the CURRENT calendar visibility + view + n + todos toggle (never
 * the date) as a new V2 view. `name` trims to a label, defaulting to
 * "View <count>". */
export function saveCurrentView(name?: string): SavedViewV2 {
  const { view, n, includeTodos } = captureCurrentView()
  const visibility = collections.value
    .filter((c) => c.kind === 'calendar' && isCalendarVisible(c.url))
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
  // `setVisibility` hides everything absent from its set, so a bare
  // `new Set([])` would blind the calendar; empty = all calendars visible.
  const visible =
    v.visibility.length === 0
      ? new Set(collections.value.filter((c) => c.kind === 'calendar').map((c) => c.url))
      : new Set(v.visibility)
  setVisibility(visible)
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
 * character, reserved by §16, or already bound to another V2 view. */
export function keybindConflict(key: string, selfId?: string): boolean {
  if (key.length !== 1 || /\s/.test(key)) return true
  if (key >= '1' && key <= '9') return true
  if (RESERVED_KEYBIND_CHARS[key]) return true
  if (RESERVED_KEYBIND_LETTERS[key.toLowerCase()]) return true
  return savedViewsV2.value.some((v) => v.keybind === key && v.id !== selfId)
}
