/** @jsxImportSource preact */
/**
 * Calendar view: FullCalendar host + our own toolbar (CONTRACTS §5, design.md §4).
 *
 * FullCalendar renders header-less; this component owns the toolbar row
 * (Today, ‹ ›, period title, view switcher, N-days stepper) and the hash state
 * (`#/?view=&date=&n=&q=`, written via history.replaceState so the back button
 * stays clean). View/duration changes go through the calendar API
 * (research §1.5–§1.6); the event feed lives in ./useCalendarEvents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { CalendarApi, CalendarOptions, DateSelectArg, DatesSetArg, EventClickArg, EventDropArg, EventMountArg } from '@fullcalendar/core'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import multiMonthPlugin from '@fullcalendar/multimonth'
import interactionPlugin, { type DateClickArg, type EventReceiveArg, type EventResizeDoneArg } from '@fullcalendar/interaction'
import { addDays, addMinutes, dayKey, fmtDate, fmtTime } from '../../lib/util/date'
import { icsDateToDate, localDateStr, localMidnight, shiftIcsDate, toIcsDateInput, type IcsDate } from '../../lib/ics/types'
import { accounts, addAccount } from '../../stores/accounts'
import type { EditScope, EventRecord } from '../../stores/events'
import { baseEvents, overrides } from '../../stores/events'
import { collections } from '../../stores/calendars'
import { initSync, syncState } from '../../lib/sync/engine'
import { prefs, setPrefs } from '../../stores/prefs'
import { push } from '../../stores/toasts'
import { parseRoutePath, ROUTES } from '../../routes'
import { openEditor } from '../event-editor/editorState'
import {
  bumpDialogClose,
  bumpDialogOpen,
  requestNewEvent,
  scopePending as scopePendingSignal,
} from '../../stores/ui'
import { Icon } from '../../ui/icons'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { CalendarEmptyState } from './CalendarEmptyState'
import { EventDetailPopover, requestDeleteEvent } from './EventDetailPopover'
import { TodoDetailPopover } from './TodoDetailPopover'
import { setTodoDue, todoKey, todos, type TodoRecord } from '../../stores/todos'
import { PeriodPickers } from './PeriodPickers'
import { ScopeModal } from './ScopeModal'
import { useCalendarEvents } from './useCalendarEvents'
import { useCalendarMove } from './useCalendarMove'
import { useShortcuts } from './useShortcuts'

import '../../styles/view-transitions.css'

// Hash state: ?view=<name>&date=<YYYY-MM-DD>&n=<int>&q=<search>

type HashView = 'day' | '3d' | '5d' | 'week' | '2weeks' | 'month' | 'agenda'

type CalendarHashState = { view: HashView; date?: string; n: number; q: string }

/** Hash view name → FullCalendar view type (CONTRACTS §5 mapping). */
const HASH_TO_FC: Record<HashView, string> = {
  day: 'timeGridDay', '3d': 'timeGridNDays', '5d': 'timeGridNDays',
  week: 'timeGridWeek', '2weeks': 'timeGridTwoWeeks', month: 'dayGridMonth', agenda: 'listAgenda',
}

const N_MIN = 1
const N_MAX = 14

/** Whitelist guard: is this string a known hash view name? */
function isHashView(s: string): s is HashView {
  return s in HASH_TO_FC
}

/** N-day preset → its day count (3 call sites must stay in lockstep). */
function presetN(view: HashView): number | null {
  return view === '3d' ? 3 : view === '5d' ? 5 : null
}

/** prefs.defaultView (a FullCalendar or hash view name) → hash view name. */
function hashViewFromPrefs(): HashView {
  const pref = prefs.value.defaultView
  if (pref in HASH_TO_FC) return pref as HashView
  for (const [hash, fc] of Object.entries(HASH_TO_FC)) if (fc === pref) return hash as HashView
  return 'week'
}

function readHashState(): CalendarHashState {
  const { query } = parseRoutePath(location.hash.replace(/^#/, '') || ROUTES.calendar)
  const rawView = query.get('view')
  const rawN = Number(query.get('n'))
  const rawDate = query.get('date')
  const view: HashView = rawView !== null && isHashView(rawView) ? rawView : hashViewFromPrefs()
  const preset = presetN(view)
  return {
    view,
    // Explicit ?n= is authoritative (a stepped N-days state survives reload,
    // §22); absent, preset views (3d/5d) pin n to their day count so the
    // segmented control and the rendered duration agree on cold load.
    n: (Number.isInteger(rawN) && rawN >= N_MIN && rawN <= N_MAX ? rawN : null) ?? preset ?? 3,
    date: rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined,
    q: query.get('q') ?? '',
  }
}

function writeHashState(s: CalendarHashState): void {
  const params = new URLSearchParams()
  params.set('view', s.view)
  if (s.date) params.set('date', s.date)
  const preset = presetN(s.view)
  if (preset != null && s.n !== preset) params.set('n', String(s.n))
  if (s.q) params.set('q', s.q)
  const qs = params.toString()
  history.replaceState(null, '', `#${ROUTES.calendar}${qs ? `?${qs}` : ''}`)
}

// FullCalendar static config (research §1.5; dayGridMonth/timeGridWeek/timeGridDay are built-ins)

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, multiMonthPlugin, interactionPlugin]

/** Custom views; timeGridNDays has NO duration — the top-level option drives it. */
const VIEWS = {
  timeGridTwoWeeks: { type: 'timeGrid', duration: { weeks: 2 } },
  timeGridNDays: { type: 'timeGrid' },
  // displayEventEnd: true undoes the global start-only pill time here — list
  // rows have a dedicated time column where "start - end" reads fine.
  listAgenda: { type: 'list', duration: { days: 14 }, displayEventEnd: true },
} satisfies NonNullable<CalendarOptions['views']>

const VIEW_OPTIONS: { value: HashView; label: string; title?: string }[] = [
  { value: 'day', label: 'Day', title: 'Day (D)' },
  { value: '3d', label: '3d', title: '3 days' },
  { value: '5d', label: '5d', title: '5 days' },
  { value: 'week', label: 'Week', title: 'Week (W)' },
  { value: '2weeks', label: '2 Weeks', title: '2 Weeks (Shift+W)' },
  { value: 'month', label: 'Month', title: 'Month (M)' },
  { value: 'agenda', label: 'Agenda', title: 'Agenda (A)' },
]

/** Mobile view-sheet rows: the same HashView values fed to switchView() as the
 *  segmented control, spelled out for the 3d/5d presets. */
const MOBILE_VIEW_LABELS: Record<HashView, string> = {
  day: 'Day',
  '3d': '3 days',
  '5d': '5 days',
  week: 'Week',
  '2weeks': '2 Weeks',
  month: 'Month',
  agenda: 'Agenda',
}

/** Segmented value: the known hash views plus the dynamic N-days segment (§22). */
type SegValue = HashView | '__n'

/** §22 time-axis zoom ladder, coarse → fine: minutes per slot. `prefs.zoom`
 *  stores raw minutes (30 default); named rungs below. 30 min is the
 *  COARSEST rung; finer rungs zoom in (⌘/Ctrl+wheel). slotDuration renders
 *  as `00:${String(m).padStart(2, '0')}:00` (minutes in the MM position); the
 *  slot label interval is `01:00:00` at every rung (60 is a whole multiple of
 *  every ladder slot, so hourly labels never double-label a slot). */
const ZOOM_LADDER: readonly number[] = [30, 20, 15, 10, 5]

/** Drag/create/resize snap granularity: 15 min where 15 divides the slot, else
 *  10, else 5 — FC's wholeDivide silently drops a snapDuration that doesn't
 *  divide slotDuration, so the snap must always divide the slot. */
const snapFor = (m: number): number => (m % 15 === 0 ? 15 : m % 10 === 0 ? 10 : 5)

const ZOOM_NAMES: Partial<Record<number, string>> = { 30: 'Comfortable', 15: 'Detailed', 5: 'Ultra' }

/** Snap a stored zoom value to the nearest ladder rung (migration safety;
 *  absent → 30, the 'Comfortable' default). */
function zoomRung(v: number | undefined): number {
  if (v === undefined) return 30
  let best = ZOOM_LADDER[0]
  for (const m of ZOOM_LADDER) if (Math.abs(m - v) < Math.abs(best - v)) best = m
  return best
}

/**
 * Event pill chrome (design.md §1): tag each event element with `.wycal-ev` and
 * its calendar color as `--ev-c`; the soft fill + 3px left bar come from
 * theme.css. Module-level = stable reference (FC handler props never churn).
 */
function onEventMount(info: EventMountArg): void {
  info.el.classList.add('wycal-ev')
  // §22 selection model: record key on the element so E / ⌫ can re-find the
  // selected event's element after FullCalendar re-renders the grid.
  info.el.dataset.wycalKey = info.event.id
  const color: string | undefined = info.event.extendedProps.color
  if (color) info.el.style.setProperty('--ev-c', color)
}

export function CalendarView() {
  // Mount-time hash snapshot. initial* options are consumed once at FullCalendar
  // init; `initial` itself never changes, so these props never churn (research §1.6).
  const [initial] = useState<CalendarHashState>(() => {
    const s = readHashState()
    // ?q= present → the search auto-switch lands on the agenda view (once).
    return s.q ? { ...s, view: 'agenda' } : s
  })

  const calendarRef = useRef<FullCalendar>(null)
  const getApi = useCallback((): CalendarApi | null => calendarRef.current?.getApi() ?? null, [])

  const [view, setView] = useState<HashView>(initial.view)
  const [nDays, setNDays] = useState(initial.n)
  const [q, setQ] = useState(initial.q)
  const [title, setTitle] = useState('')
  const [fcView, setFcView] = useState<string>(HASH_TO_FC[initial.view])
  const [scopeResolve, setScopeResolve] = useState<((scope: EditScope | null) => void) | null>(null)
  // §9.2 month/year dropdown navigation: the displayed period (from datesSet)
  // and which picker popover is open, if any.
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { y: now.getFullYear(), m: now.getMonth() }
  })
  const [periodPop, setPeriodPop] = useState<'month' | 'year' | null>(null)

  // --- §mobile bottom bar (calendar view, <768px) ------------------------------
  // 'View' opens the view/zoom sheet above the bar; outside click, Esc, or a
  // selection closes it. While up it registers as a dialog so the §16 global
  // keybinds stay gated (same bumpDialogOpen pattern as the other popovers).
  const [viewSheetOpen, setViewSheetOpen] = useState(false)
  const bottomBarRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!viewSheetOpen) return
    bumpDialogOpen()
    const onPointerDown = (e: PointerEvent) => {
      if (!bottomBarRef.current?.contains(e.target as Node)) setViewSheetOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewSheetOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      bumpDialogClose()
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [viewSheetOpen])

  // Mirrors for the stable callbacks below (FC handler props never churn).
  const viewRef = useRef(view); viewRef.current = view
  const nRef = useRef(nDays); nRef.current = nDays
  const qRef = useRef(q); qRef.current = q
  const fcViewRef = useRef(fcView); fcViewRef.current = fcView
  const dateRef = useRef<string | undefined>(initial.date)
  const lastWrittenHashDateRef = useRef<string | undefined>(initial.date)
  const scopeResolveRef = useRef(scopeResolve); scopeResolveRef.current = scopeResolve

  /** Resolve the pending recurring-edit scope request (null = cancel → revert). */
  const resolveScope = (scope: EditScope | null) => {
    scopeResolveRef.current?.(scope)
    setScopeResolve(null)
    scopePendingSignal.value = false
  }
  const scopePending = useCallback((): boolean => scopeResolveRef.current !== null, [])
  const lastSearchRef = useRef(initial.q)

  const events = useCalendarEvents(getApi, q, fcView === 'listAgenda')

  // --- §22 event detail popover + selected-event model -----------------------
  // Selection = last-clicked event (crisp outline on its element); gives
  // E / ⌫ a target and the popover its anchor. Element lookup survives FC
  // re-renders via the data-wycal-key tag from eventDidMount.
  const [detail, setDetail] = useState<
    { record: EventRecord; anchor: HTMLElement } | { todo: TodoRecord; anchor: HTMLElement } | null
  >(null)
  const selectedRef = useRef<{ key: string; record: EventRecord; el: HTMLElement | null } | null>(null)

  const markSelected = useCallback((sel: { key: string; record: EventRecord; el: HTMLElement | null } | null) => {
    const prev = selectedRef.current?.el
    if (prev) {
      prev.style.outline = ''
      prev.style.outlineOffset = ''
    }
    selectedRef.current = sel
    if (sel?.el) {
      sel.el.style.outline = '2px solid var(--accent)'
      sel.el.style.outlineOffset = '1px'
    }
  }, [])

  const closeDetail = useCallback(() => {
    markSelected(null)
    setDetail(null)
  }, [])

  const openDetail = useCallback((record: EventRecord, anchor: HTMLElement | null) => {
    if (!anchor) return
    markSelected({ key: record.key, record, el: anchor })
    setDetail({ record, anchor })
  }, [markSelected])

  /** Clicked a calendar todo chip (§15/§22): show the todo popover instead.
   * Todos are FC-only inputs (no EventRecord), so they never join the E/⌫
   * selection model — an existing event selection outline yields. */
  const openTodoDetail = useCallback((todo: TodoRecord, anchor: HTMLElement | null) => {
    if (!anchor) return
    markSelected(null)
    setDetail({ todo, anchor })
  }, [markSelected])

  /** `E` (§22): open the detail popover for the selected event (no-op if none). */
  const openDetailForSelected = useCallback(() => {
    const sel = selectedRef.current
    if (!sel) return
    const el = document.querySelector<HTMLElement>(`[data-wycal-key="${CSS.escape(sel.key)}"]`) ?? sel.el
    openDetail(sel.record, el)
  }, [openDetail])

  /** `⌫`/`Delete` (§22): delete flow for the selected event (no-op if none). */
  const deleteSelectedEvent = useCallback(() => {
    const sel = selectedRef.current
    if (!sel) return
    closeDetail()
    requestDeleteEvent(sel.record)
  }, [closeDetail])

  // --- §22 view motion --------------------------------------------------------
  // Enter-only animations on the owned stage div around <FullCalendar> (never
  // FC internals); the class is removed on animationend with a timer belt.
  const stageRef = useRef<HTMLDivElement | null>(null)
  const gridWrapRef = useRef<HTMLDivElement | null>(null)
  const animCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => animCleanupRef.current?.(), [])

  const playNavAnim = useCallback((cls: 'wycal-anim-prev' | 'wycal-anim-next' | 'wycal-anim-view') => {
    const el = stageRef.current
    if (!el) return
    animCleanupRef.current?.()
    el.classList.remove('wycal-anim-prev', 'wycal-anim-next', 'wycal-anim-view')
    void el.offsetWidth // restart the enter animation on rapid repeats
    el.classList.add(cls)
    const end = () => {
      el.classList.remove(cls)
      animCleanupRef.current = null
    }
    el.addEventListener('animationend', end, { once: true })
    const timer = window.setTimeout(end, 220)
    animCleanupRef.current = () => {
      window.clearTimeout(timer)
      el.removeEventListener('animationend', end)
      el.classList.remove(cls)
    }
  }, [])

  /** Prev/next/today funnel — adds the directional enter-motion class. */
  const navigate = useCallback((dir: 'prev' | 'next' | 'today') => {
    playNavAnim(dir === 'prev' ? 'wycal-anim-prev' : dir === 'next' ? 'wycal-anim-next' : 'wycal-anim-view')
    const api = getApi()
    if (dir === 'prev') api?.prev()
    else if (dir === 'next') api?.next()
    else api?.today()
  }, [getApi, playNavAnim])

  // --- §22 live drag-select tooltip -------------------------------------------
  // selectAllow fires continuously while the selection grows: the chip shows
  // the forming range and follows the pointer (document pointermove listener,
  // installed on the first selectAllow, removed on select/unselect/unmount).
  const [dragTip, setDragTip] = useState<string | null>(null)
  const dragTipRef = useRef<HTMLDivElement | null>(null)
  const dragMoveRef = useRef<((e: PointerEvent) => void) | null>(null)
  const dragPointerMoveRef = useRef<(e: PointerEvent) => void>(() => {})

  const endDragTip = useCallback(() => {
    if (dragMoveRef.current) {
      document.removeEventListener('pointermove', dragMoveRef.current)
      dragMoveRef.current = null
    }
    setDragTip(null)
  }, [])
  useEffect(() => endDragTip, [endDragTip])

  dragPointerMoveRef.current = (e: PointerEvent) => {
    const el = dragTipRef.current
    if (!el) return
    const left = Math.min(e.clientX + 14, window.innerWidth - el.offsetWidth - 8)
    const top = Math.min(e.clientY + 16, window.innerHeight - el.offsetHeight - 8)
    el.style.left = `${Math.max(8, left)}px`
    el.style.top = `${Math.max(8, top)}px`
  }

  const onSelectAllow = useCallback((span: { start: Date; end: Date; allDay?: boolean }) => {
    if (!dragMoveRef.current) {
      const move = (e: PointerEvent) => dragPointerMoveRef.current(e)
      dragMoveRef.current = move
      document.addEventListener('pointermove', move, { passive: true })
    }
    const { hour12 } = prefs.value
    const { start, end } = span
    const text =
      span.allDay || dayKey(start) !== dayKey(end)
        ? span.allDay
          ? `${fmtDate(start)} – ${fmtDate(addDays(end, -1))}` // all-day end is exclusive
          : `${fmtDate(start, { weekday: true })} ${fmtTime(start, hour12)} – ${fmtDate(end, { weekday: true })} ${fmtTime(end, hour12)}`
        : `${fmtTime(start, hour12)} – ${fmtTime(end, hour12)}`
    setDragTip(text)
    return true
  }, [])

  // --- §22 time-axis zoom ------------------------------------------------------
  // ZOOM_LADDER minutes; + steps finer (zoom in), − coarser. ⌘/Ctrl+wheel over
  // the grid steps the same ladder live (setOption now, prefs debounced 300ms)
  // with a transient `${m} min slots` pill over the grid's top-right.
  const zoomPersistTimer = useRef<number>(0)
  const zoomPillTimer = useRef<number>(0)
  const [zoomPill, setZoomPill] = useState<string | null>(null)

  const applyZoom = useCallback((m: number, persist: 'now' | 'debounced') => {
    const api = getApi()
    api?.setOption('slotDuration', `00:${String(m).padStart(2, '0')}:00`)
    api?.setOption('snapDuration', `00:${String(snapFor(m)).padStart(2, '0')}:00`)
    api?.setOption('slotLabelInterval', '01:00:00')
    window.clearTimeout(zoomPersistTimer.current)
    if (persist === 'now') setPrefs({ zoom: m })
    else zoomPersistTimer.current = window.setTimeout(() => setPrefs({ zoom: m }), 300)
  }, [getApi])

  /** Toolbar −/+ (and keyboard parity): one ladder rung per step. */
  const stepZoom = useCallback((delta: 1 | -1) => {
    const cur = ZOOM_LADDER.indexOf(zoomRung(prefs.value.zoom))
    const next = Math.min(ZOOM_LADDER.length - 1, Math.max(0, cur + delta))
    if (next === cur) return
    applyZoom(ZOOM_LADDER[next], 'now')
  }, [applyZoom])

  // ⌘/Ctrl+wheel zoom (timeGrid views only): wheel up = zoom in (finer slots),
  // down = zoom out. preventDefault ONLY when the modifier is held, so plain
  // scrolling is untouched. A 120ms gate turns one trackpad gesture into
  // rung-by-rung steps instead of blasting through the ladder.
  const wheelGate = useRef(0)
  // First-paint skeleton (design.md §5 loading): while an initial sync is in
  // flight and the events store is still empty, pulse rows stand in for the
  // grid instead of mounting FullCalendar over nothing. Hoisted above the
  // ⌘/Ctrl+wheel effect so that effect can re-run once the grid mounts.
  const initialSyncing =
    accounts.value.length > 0 &&
    [...syncState.value.values()].some((s) => s.state === 'syncing') &&
    baseEvents.value.size === 0 &&
    overrides.value.size === 0
  useEffect(() => {
    const el = gridWrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!fcViewRef.current.startsWith('timeGrid') || !stageRef.current) return
      e.preventDefault()
      const now = Date.now()
      if (now - wheelGate.current < 120) return
      wheelGate.current = now
      const cur = ZOOM_LADDER.indexOf(zoomRung(prefs.value.zoom))
      const next = Math.min(ZOOM_LADDER.length - 1, Math.max(0, cur + (e.deltaY < 0 ? 1 : -1)))
      if (next === cur) return
      applyZoom(ZOOM_LADDER[next], 'debounced')
      setZoomPill(`${ZOOM_LADDER[next]} min slots`)
      window.clearTimeout(zoomPillTimer.current)
      zoomPillTimer.current = window.setTimeout(() => setZoomPill(null), 800)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyZoom, !initialSyncing])
  useEffect(() => () => {
    window.clearTimeout(zoomPersistTimer.current)
    window.clearTimeout(zoomPillTimer.current)
  }, [])

  // --- §22 sidebar edge drag-resize -------------------------------------------
  // The aside belongs to Sidebar.tsx; the 6px col-resize handle is mounted
  // from here as a body-level fixed element positioned off the aside's rect
  // (ResizeObserver keeps it glued through drawer/resize changes), so
  // Sidebar.tsx stays untouched. Dragging writes the `--sidebar-w` var on
  // <html> (clamped 200–420px; the theme.css token is the fallback) and
  // persists prefs.sidebarWidth debounced 300ms; the saved width is applied
  // here on boot (inline var beats the :root token).
  useEffect(() => {
    const aside = document.querySelector<HTMLElement>('aside[aria-label="Calendar sidebar"]')
    if (!aside) return
    const root = document.documentElement
    const mq = window.matchMedia('(min-width: 768px)')
    const clampW = (w: number) => Math.min(420, Math.max(200, Math.round(w)))

    const handle = document.createElement('div')
    handle.className = 'wycal-sidebar-handle'
    handle.setAttribute('aria-hidden', 'true')
    document.body.appendChild(handle)

    let persistTimer = 0
    let dragging = false

    const sync = () => {
      if (!mq.matches) {
        handle.style.display = 'none'
        return
      }
      const r = aside.getBoundingClientRect()
      // Collapsed desktop column (md:w-0) — nothing to grab.
      if (r.width < 40) {
        handle.style.display = 'none'
        return
      }
      handle.style.display = ''
      handle.style.top = `${r.top}px`
      handle.style.height = `${r.height}px`
      handle.style.left = `${r.right - 3}px`
    }
    const onDown = (e: PointerEvent) => {
      if (!mq.matches || e.button !== 0) return
      dragging = true
      handle.setPointerCapture(e.pointerId)
      handle.classList.add('wycal-dragging')
      aside.style.transition = 'none' // width tracks the pointer, no 200ms chase
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      root.style.setProperty('--sidebar-w', `${clampW(e.clientX - aside.getBoundingClientRect().left)}px`)
      sync()
    }
    const onUp = () => {
      if (!dragging) return
      dragging = false
      handle.classList.remove('wycal-dragging')
      aside.style.transition = ''
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const w = clampW(parseFloat(getComputedStyle(aside).width))
      window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(() => setPrefs({ sidebarWidth: w }), 300)
    }
    handle.addEventListener('pointerdown', onDown)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)

    const ro = new ResizeObserver(sync)
    ro.observe(aside)
    mq.addEventListener('change', sync)
    root.style.setProperty('--sidebar-w', `${clampW(prefs.value.sidebarWidth ?? 264)}px`)
    sync()

    return () => {
      ro.disconnect()
      mq.removeEventListener('change', sync)
      handle.removeEventListener('pointerdown', onDown)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      handle.remove()
      window.clearTimeout(persistTimer)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  /** Persist view state to the hash query (replaceState — no history spam). */
  const syncHash = useCallback((patch: { view?: HashView; n?: number; date?: string }) => {
    const api = getApi()
    writeHashState({
      view: patch.view ?? viewRef.current,
      n: patch.n ?? nRef.current,
      date: patch.date ?? (api ? localDateStr(api.getDate()) : undefined),
      q: qRef.current,
    })
  }, [getApi])

  /** Segmented/keyboard/drill-down view switch: drive duration for N-day
   * presets, then changeView (optionally landing on `date`); §22 adds the
   * fade-zoom enter animation. */
  const switchView = useCallback((next: HashView, date?: Date) => {
    playNavAnim('wycal-anim-view')
    viewRef.current = next
    setView(next)
    const api = getApi()
    const preset = presetN(next)
    if (preset != null) {
      nRef.current = preset
      setNDays(preset)
      api?.setOption('duration', { days: preset })
    }
    if (date) api?.changeView(HASH_TO_FC[next], date)
    else api?.changeView(HASH_TO_FC[next])
    syncHash({ view: next, n: preset ?? nRef.current })
  }, [getApi, syncHash, playNavAnim])

  /** N-days stepper −/+ (1–14): duration option + hash, live (research §1.6). */
  const stepNDays = useCallback((delta: 1 | -1) => {
    const next = Math.min(N_MAX, Math.max(N_MIN, nRef.current + delta))
    if (next === nRef.current) return
    nRef.current = next
    setNDays(next)
    const api = getApi()
    api?.setOption('duration', { days: next })
    syncHash({ n: next })
  }, [getApi, syncHash])

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    setTitle(arg.view.title)
    fcViewRef.current = arg.view.type
    setFcView(arg.view.type)
    dateRef.current = localDateStr(arg.view.currentStart)
    setCursor({ y: arg.view.currentStart.getFullYear(), m: arg.view.currentStart.getMonth() })
    // External hash writes (saved-view apply) carry a date FullCalendar hasn't
    // navigated to yet; their pending hashchange would be clobbered if we
    // replaceState'd FC's stale date over it. Skip the write when the hash
    // holds a date we neither rendered nor wrote last (the hashchange handler
    // will gotoDate and the following datesSet writes it back).
    const target = readHashState().date
    if (target === undefined || target === dateRef.current || target === lastWrittenHashDateRef.current) {
      lastWrittenHashDateRef.current = dateRef.current
      syncHash({ date: dateRef.current })
    }
  }, [syncHash])

  // Interactions (research §1.8)

  const onSelect = useCallback((info: DateSelectArg) => {
    endDragTip()
    openEditor({
      mode: 'create',
      startUtc: info.start.toISOString(),
      endUtc: info.end.toISOString(),
      allDay: info.allDay,
    })
    getApi()?.unselect()
  }, [getApi, endDragTip])

  const onDateClick = useCallback((info: DateClickArg) => {
    if (info.allDay) {
      openEditor({ mode: 'create', startUtc: info.date.toISOString(), allDay: true })
      return
    }
    const start = info.date
    openEditor({
      mode: 'create', startUtc: start.toISOString(), allDay: false,
      endUtc: addMinutes(start, prefs.value.defaultDurationMin).toISOString(),
    })
  }, [])

  /** §19 one-click bootstrap: provision the local Radicale admin, then sync. */
  const connectAdmin = useCallback(() => {
    addAccount({ url: `${location.origin}/dav`, username: 'admin', password: 'admin', rememberPassword: false })
    initSync() // Idempotent (engine guards re-init); its accounts effect syncs the new account.
  }, [])

  /** §22 month drill-down: day numbers (month view) and day headers (timeGrid)
   * are links into the day view — FC swallows dateClick on them, so a
   * day-number click never creates an event. */
  const onNavLinkDay = useCallback((date: Date, jsEvent: UIEvent) => {
    jsEvent.preventDefault()
    switchView('day', date)
  }, [switchView])

  /** Week-number links (rendered only while weekNumbers is on; wired for parity). */
  const onNavLinkWeek = useCallback((weekStart: Date, jsEvent: UIEvent) => {
    jsEvent.preventDefault()
    switchView('week', weekStart)
  }, [switchView])

  const onEventClick = useCallback((info: EventClickArg) => {
    info.jsEvent?.preventDefault()
    const rec: EventRecord | undefined = info.event.extendedProps.record
    // §22: a click inspects (detail popover); the full editor stays behind
    // the popover's Edit button. Calendar todo chips (§15, `todo:` ids) get
    // the todo popover with its quick actions instead of the event one —
    // no more redirect to the Tasks view.
    if (rec) openDetail(rec, info.el)
    else if (info.event.extendedProps.todo) openTodoDetail(info.event.extendedProps.todo as TodoRecord, info.el)
  }, [openDetail, openTodoDetail])

  /** Recurring series ask for an edit scope via the ScopeModal (null = cancel). */
  const askScope = useCallback(async (): Promise<EditScope | null> => {
    scopePendingSignal.value = true
    const scope = await new Promise<EditScope | null>((resolve) => setScopeResolve(() => resolve))
    scopePendingSignal.value = false
    setScopeResolve(null)
    return scope
  }, [])
  // --- Todo drag-to-reschedule (Things-style) ---------------------------------
  // Todo chips (`todo:` ids from useCalendarEvents, extendedProps.todo) are
  // FC-only inputs with no EventRecord, so useCalendarMove reverts them; these
  // handlers intercept first. Dropping a chip on another day writes the new
  // DUE through the store (setTodoDue) — the debounced feed refetch re-renders
  // the chip, so FC's visual move stands and info.revert() runs only on
  // failure. A timed due keeps its wall time-of-day (drop day + old time,
  // form class preserved); anything else lands as an all-day due on the
  // dropped day. Success pushes an Undo toast that writes the original due
  // back. Resizing is a no-op (todos have no duration).
  const { onEventDrop: onEventMove, onEventResize: onEventResizeMove } = useCalendarMove(askScope)

  /** Compute + persist the dropped todo's new due; false → store rolled back. */
  const applyTodoMove = useCallback(async (todo: TodoRecord, start: Date, allDay: boolean): Promise<boolean> => {
    // The feed's record snapshot can lag a quick edit; read the live record so
    // the PUT's If-Match etag is current.
    const rec = todos.value.get(todoKey(todo.data.uid, todo.calendarUrl)) ?? todo
    const oldDue = rec.data.due
    let due: IcsDate
    if (!allDay && oldDue !== undefined && oldDue.date === undefined) {
      // Timed due: keep its wall time-of-day on the dropped day. Shifting by a
      // whole-day delta preserves the form class (floating / UTC / TZID).
      const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      due = shiftIcsDate(oldDue, midnight(start) - midnight(icsDateToDate(oldDue)))
    } else {
      // All-day drop, or no timed due to preserve → all-day on the dropped day.
      due = toIcsDateInput(start, true)
    }
    try {
      await setTodoDue(rec, due)
    } catch {
      return false // store rolled back + toasted; the caller reverts FC's move
    }
    push('success', `Task moved to ${fmtDate(start, { weekday: true })}`, {
      label: 'Undo',
      run: () => void setTodoDue(rec, oldDue).catch(() => {}),
    })
    return true
  }, [])

  const onEventDrop = useCallback(
    (info: EventDropArg) => {
      const todo = info.event.extendedProps.todo as TodoRecord | undefined
      if (todo === undefined) {
        onEventMove(info)
        return
      }
      if (info.event.start === null) {
        info.revert()
        return
      }
      void applyTodoMove(todo, info.event.start, info.event.allDay).then((ok) => {
        if (!ok) info.revert()
      })
    },
    [onEventMove, applyTodoMove],
  )

  /** Todos have no duration: a resize writes nothing — snap the chip back. */
  const onEventResize = useCallback(
    (info: EventResizeDoneArg) => {
      if (info.event.extendedProps.todo !== undefined) {
        info.revert()
        return
      }
      onEventResizeMove(info)
    },
    [onEventResizeMove],
  )

  /**
   * External todo drop (eventReceive; fires only once a draggable source is
   * wired up elsewhere): same due write as onEventDrop, but FC's auto-created
   * ghost event is always removed — the store feed renders the real chip.
   * Non-todo receives keep FC's default behavior.
   */
  const onEventReceive = useCallback(
    (info: EventReceiveArg) => {
      const todo = info.event.extendedProps.todo as TodoRecord | undefined
      if (todo === undefined) return
      const start = info.event.start
      const allDay = info.event.allDay
      info.revert()
      if (start === null) return
      void applyTodoMove(todo, start, allDay)
    },
    [applyTodoMove],
  )

  // Route change with the scope dialog still up: never leave the global
  // dialog gate stuck closed.
  useEffect(() => () => { scopePendingSignal.value = false }, [])

  // External hash changes (e.g. the header search box writes ?q=)

  useEffect(() => {
    const onHashChange = () => {
      const next = readHashState()
      if (next.q !== qRef.current) {
        qRef.current = next.q
        setQ(next.q)
      }
      if (next.q && next.q !== lastSearchRef.current) {
        // Auto-switch to the agenda once per search term; navigating away
        // afterwards is allowed (the flag blocks re-triggering for this term).
        lastSearchRef.current = next.q
        if (fcViewRef.current !== 'listAgenda') switchView('agenda')
      } else if (!next.q) {
        lastSearchRef.current = ''
      }
      if (next.view !== viewRef.current) {
        // Atomic view+date: hand the target date to switchView so its
        // changeView lands there directly — a separate gotoDate after the
        // switch would race switchView's own (old-date) hash write-back.
        const dateTarget = next.date && next.date !== dateRef.current ? localMidnight(next.date) : undefined
        if (dateTarget) lastWrittenHashDateRef.current = next.date
        switchView(next.view, dateTarget)
      } else if (next.n !== nRef.current && HASH_TO_FC[next.view] === 'timeGridNDays') {
        nRef.current = next.n
        setNDays(next.n)
        getApi()?.setOption('duration', { days: next.n })
        syncHash({ n: next.n })
      }
      if (next.view === viewRef.current && next.date && next.date !== dateRef.current) {
        // Consume the target: the datesSet that follows this gotoDate must
        // write FC's (new) date back over the hash, not skip as a race.
        lastWrittenHashDateRef.current = next.date
        getApi()?.gotoDate(localMidnight(next.date))
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [switchView, syncHash, getApi])

  // Keyboard shortcuts (CONTRACTS §6/§16; only on the #/ route = while mounted)
  useShortcuts({
    getApi,
    switchView,
    scopePending,
    stepNDays,
    navigate,
    openEventDetails: openDetailForSelected,
    deleteSelectedEvent,
  })

  // Render

  const { hour12 } = prefs.value
  const formats = useMemo(() => ({
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12 } as const,
    // Start-only: the end time made pills run on ("09:30 - 10:00 - Team stand…")
    // and clip badly; displayEventEnd: false (below) drops it. The agenda view
    // restores it (VIEWS) so list rows keep the full "start - end" range.
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12 } as const,
  }), [hour12])
  const durationOpt = useMemo(() => ({ days: nDays }), [nDays])

  // §22 N-days stepper: when the day count matches no preset view, no preset is
  // highlighted — a dynamic '{n} days' segment carries the state instead.
  const customN = fcView === 'timeGridNDays' && presetN(view) !== nDays
  const segValue: SegValue = customN ? '__n' : view
  const segOptions = useMemo<readonly SegmentedOption<SegValue>[]>(
    () => (customN
      ? [...VIEW_OPTIONS, { value: '__n' as const, label: `${nDays} days`, title: `${nDays} days` }]
      : VIEW_OPTIONS),
    [customN, nDays],
  )

  // §22 time-axis zoom (timeGrid views only): prefs.zoom = minutes.
  const isTimeGrid = fcView.startsWith('timeGrid')
  const zoomMin = zoomRung(prefs.value.zoom)
  const zoomIdx = ZOOM_LADDER.indexOf(zoomMin)

  const isEmpty = collections.value.length === 0 && ![...syncState.value.values()].some((s) => s.state === 'syncing')
  if (isEmpty) {
    // Account exists but its sync errored before any collection arrived →
    // engine message + Retry/Open Settings instead of "add an account".
    const errored = [...syncState.value.values()].find((s) => s.state === 'error')
    const syncError =
      accounts.value.length > 0 && errored ? (errored.message ?? 'Sync failed — check the account in Settings.') : null
    return <CalendarEmptyState onConnect={connectAdmin} syncError={syncError} />
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="fc-toolbar-scroll flex items-center gap-2 px-3 py-2">
        <button type="button" class="btn btn-sm shrink-0 max-md:order-last" title="Today (.)" onClick={() => navigate('today')}>Today</button>
        <button type="button" class="btn btn-ghost btn-sm shrink-0 max-md:hidden" aria-label="Previous period" title="Previous (←)" onClick={() => navigate('prev')}>
          <Icon.chevronLeft size={16} />
        </button>
        <button type="button" class="btn btn-ghost btn-sm shrink-0 max-md:hidden" aria-label="Next period" title="Next (→)" onClick={() => navigate('next')}>
          <Icon.chevronRight size={16} />
        </button>
        {fcView === 'dayGridMonth' ? (
          // §9.2: in month view the period label splits into month + year dropdowns.
          <PeriodPickers
            cursor={cursor}
            pop={periodPop}
            setPop={setPeriodPop}
            onPick={(date) => {
              setPeriodPop(null)
              getApi()?.gotoDate(date)
            }}
          />
        ) : (
          <h2 class="min-w-0 truncate text-xl font-bold tabular-nums max-md:text-sm max-md:font-semibold">{title}</h2>
        )}
        <div class="min-w-3 flex-1" />
        <Segmented<SegValue> value={segValue} options={segOptions} onChange={(v) => { if (v !== '__n') switchView(v) }} ariaLabel="View" class="shrink-0 max-md:hidden" />
        {(fcView === 'timeGridNDays' || isTimeGrid) && (
          // Divider between the segmented control and the counter pills: the
          // pills must read as counters, never as navigation (user report).
          <span aria-hidden="true" class="mx-0.5 h-5 w-px shrink-0 bg-(--border) max-md:hidden" />
        )}
        {fcView === 'timeGridNDays' && (
          // §22 counter pill — −/+ live INSIDE the pill so they can't be
          // mistaken for prev/next arrows. `− N days +` per CONTRACTS §22.
          <div class="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2 max-md:hidden" role="group" aria-label="Days shown">
            <button type="button" class="btn btn-xs" aria-label="Fewer days" title="Fewer days (−)" disabled={nDays <= N_MIN} onClick={() => stepNDays(-1)}>−</button>
            <span class="min-w-12 px-0.5 text-center text-xs tabular-nums" aria-live="polite">{nDays} days</span>
            <button type="button" class="btn btn-xs" aria-label="More days" title="More days (+)" disabled={nDays >= N_MAX} onClick={() => stepNDays(1)}>+</button>
          </div>
        )}
        {isTimeGrid && (
          <div
            class="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2 max-md:hidden"
            role="group"
            aria-label="Zoom time axis"
            title={`Zoom time axis — ${ZOOM_NAMES[zoomMin] ?? `${zoomMin} min`} (${zoomMin} min slots)`}
          >
            <button type="button" class="btn btn-xs" aria-label="Zoom out time axis" title="Zoom out (coarser time axis)" disabled={zoomIdx === 0} onClick={() => stepZoom(-1)}>−</button>
            <span class="min-w-8 px-0.5 text-center text-xs">Zoom</span>
            <button type="button" class="btn btn-xs" aria-label="Zoom in time axis" title="Zoom in (finer time axis)" disabled={zoomIdx === ZOOM_LADDER.length - 1} onClick={() => stepZoom(1)}>+</button>
          </div>
        )}
      </div>
      <div ref={gridWrapRef} class="wycal-stage-wrap min-h-0 flex-1">
        {initialSyncing ? (
          <div class="flex h-full flex-col justify-center gap-3 p-6" aria-busy="true">
            <p class="sr-only">Loading calendar…</p>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} class="h-10 w-full animate-pulse rounded bg-surface-2" aria-hidden="true" />
            ))}
          </div>
        ) : (
          <div ref={stageRef} class="relative h-full">
          <FullCalendar
          ref={calendarRef}
          plugins={PLUGINS}
          views={VIEWS}
          duration={durationOpt}
          headerToolbar={false}
          height="100%"
          initialView={HASH_TO_FC[initial.view]}
          initialDate={initial.date ? localMidnight(initial.date) : undefined}
          firstDay={prefs.value.firstDay}
          expandRows
          nowIndicator
          slotDuration={`00:${String(zoomMin).padStart(2, '0')}:00`}
          slotLabelInterval="01:00:00"
          scrollTime="07:00"
          businessHours={{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00' }}
          dayMaxEvents
          eventMaxStack={4}
          weekNumbers={false}
          allDayMaintainDuration={false}
          slotLabelFormat={formats.slotLabelFormat}
          eventTimeFormat={formats.eventTimeFormat}
          displayEventEnd={false}
          selectable
          editable
          selectMirror
          snapDuration={`00:${String(snapFor(zoomMin)).padStart(2, '0')}:00`}
          navLinks
          navLinkDayClick={onNavLinkDay}
          navLinkWeekClick={onNavLinkWeek}
          selectAllow={onSelectAllow}
          unselect={endDragTip}
          events={events}
          eventDidMount={onEventMount}
          datesSet={onDatesSet}
          select={onSelect}
          dateClick={onDateClick}
          eventClick={onEventClick}
          eventDrop={onEventDrop}
          eventResize={onEventResize}
          eventReceive={onEventReceive}
          />
          {zoomPill && (
            // §22: transient zoom feedback over the grid's top-right (800ms),
            // e.g. "15 min slots" after a ⌘/Ctrl+wheel step.
            <div
              role="status"
              class="card pointer-events-none absolute top-2 right-3 z-30 rounded-full px-2.5 py-1 text-xs text-fg-strong tabular-nums shadow-[var(--shadow-1)]"
            >
              {zoomPill}
            </div>
          )}
          {dragTip && (
            <div
              ref={dragTipRef}
              role="status"
              class="card pointer-events-none fixed z-50 whitespace-nowrap rounded px-2 py-1 text-xs text-fg-strong tabular-nums shadow-[var(--shadow-2)]"
              style={{ left: '-9999px', top: '8px' }}
            >
              {dragTip}
            </div>
          )}
          </div>
        )}
      </div>
      {/* §mobile bottom action bar (<768px only): ‹ · Today · ＋ · View · ›.
          The ＋ reuses the sidebar "New event" create path (requestNewEvent →
          openEditor({ mode: 'create', … })); the editor's z-50 modal overlay
          covers the bar while it is up. */}
      <div ref={bottomBarRef} class="wycal-mobile-bar md:hidden">
        {viewSheetOpen && (
          <div role="dialog" aria-label="Choose view" class="card wycal-view-sheet">
            <div class="grid grid-cols-2 gap-1">
              {VIEW_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  class={`btn btn-sm justify-start ${o.value === 'agenda' ? 'col-span-2' : ''} ${
                    segValue === o.value ? 'btn-primary' : 'btn-ghost'
                  }`}
                  aria-current={segValue === o.value ? 'true' : undefined}
                  onClick={() => {
                    setViewSheetOpen(false)
                    switchView(o.value)
                  }}
                >
                  {MOBILE_VIEW_LABELS[o.value]}
                </button>
              ))}
            </div>
            {fcView === 'timeGridNDays' && (
              <div class="flex items-center justify-between gap-2" role="group" aria-label="Days shown">
                <span class="text-xs text-muted">Days</span>
                <div class="flex items-center gap-1">
                  <button type="button" class="btn btn-sm" aria-label="Fewer days" disabled={nDays <= N_MIN} onClick={() => stepNDays(-1)}>−</button>
                  <span class="min-w-12 text-center text-xs tabular-nums" aria-live="polite">{nDays} days</span>
                  <button type="button" class="btn btn-sm" aria-label="More days" disabled={nDays >= N_MAX} onClick={() => stepNDays(1)}>+</button>
                </div>
              </div>
            )}
            {isTimeGrid && (
              <div class="flex items-center justify-between gap-2" role="group" aria-label="Zoom time axis">
                <span class="text-xs text-muted">Zoom</span>
                <div class="flex items-center gap-1">
                  <button type="button" class="btn btn-sm" aria-label="Zoom out time axis" disabled={zoomIdx === 0} onClick={() => stepZoom(-1)}>−</button>
                  <span class="min-w-14 text-center text-xs tabular-nums">{zoomMin} min</span>
                  <button type="button" class="btn btn-sm" aria-label="Zoom in time axis" disabled={zoomIdx === ZOOM_LADDER.length - 1} onClick={() => stepZoom(1)}>+</button>
                </div>
              </div>
            )}
          </div>
        )}
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Previous period" title="Previous" onClick={() => navigate('prev')}>
          <Icon.chevronLeft size={18} />
        </button>
        <button type="button" class="btn btn-ghost btn-sm" title="Today" onClick={() => navigate('today')}>Today</button>
        <button type="button" class="wycal-fab" aria-label="New event" title="New event" onClick={requestNewEvent}>
          <Icon.plus size={22} />
        </button>
        <button type="button" class="btn btn-ghost btn-sm" aria-expanded={viewSheetOpen} onClick={() => setViewSheetOpen((o) => !o)}>View</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Next period" title="Next" onClick={() => navigate('next')}>
          <Icon.chevronRight size={18} />
        </button>
      </div>
      <ScopeModal open={scopeResolve !== null} onResolve={resolveScope} />
      {detail &&
        ('todo' in detail ? (
          <TodoDetailPopover record={detail.todo} anchor={detail.anchor} onClose={closeDetail} />
        ) : (
          <EventDetailPopover record={detail.record} anchor={detail.anchor} onClose={closeDetail} />
        ))}
    </div>
  )
}
