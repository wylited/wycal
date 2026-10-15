/** @jsxImportSource preact */
/**
 * Agenda view list (§agenda): the 'agenda' hash view renders this instead of
 * the FullCalendar host. Same data path as the listAgenda feed in
 * ./useCalendarEvents — occurrences() over the loaded window + todo records
 * of agenda-visible calendars (the agenda's own visibility domain, disjoint
 * from the schedule grid's — stores/calendars.ts), ` (CalendarName)`
 * attribution suffix included — grouped org-super-agenda style. The window is
 * INFINITE: it starts at
 * CalendarView's initial 14 days and grows +14d whenever the bottom sentinel
 * nears the viewport (no range chips). Grouping (Day|Calendar) lives in the
 * toolbar/bottom-bar toggle; todo/event filtering power lives in the sidebar
 * (stores/agendaFilters signals + prefs.agendaEvents), read here via signal
 * values so chip clicks re-render the list.
 *
 * Day grouping: chronological day sections; rows are muted time + color dot +
 * title (todos: status checkbox, completed struck-through muted) + the
 * ` (CalendarName)` suffix. Calendar grouping (§agenda-kanban): a
 * horizontally scrolling kanban — one column per visible calendar
 * (prefs.calendarOrder first, then collection order; header drag swaps the
 * order), day sections inside, rows time+title only (the column IS the
 * calendar), first 10 rows per column behind a 'Show N more' expander.
 * Row clicks open the same detail popovers the FC grid uses, via the
 * onEventClick/onTodoClick props CalendarView wires.
 */
import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { addDays, dayKey, fmtTime } from '@wycal/core/lib/util/date'
import {
  agendaDayLabel,
  collectAgendaItems,
  groupByCalendar,
  groupByDay,
  orderedCalendars,
  type AgendaGroup,
  type AgendaItem,
} from '@wycal/core/lib/agenda/agendaModel'
import { occurrences, revision as eventRevision, type EventRecord } from '@wycal/core/stores/events'
import { collectionColor, collections, isCalendarVisible, visibilityVersion } from '@wycal/core/stores/calendars'
import { isTodoDone, revision as todoRevision, todos, toggleDone, type TodoRecord } from '@wycal/core/stores/todos'
import { prefs, setPrefs } from '@wycal/core/stores/prefs'
import { agendaFilters } from '@wycal/core/stores/agendaFilters' // sidebar filter chips (N1): status/priority computed, tags signal
import { Icon } from '../../ui/icons'

// --- Palette → detail-popover anchor registry (detailRequest.ts contract) ---
// `${calendarUrl}|${uid}` → the element representing that record. Both anchor
// sources register here: FullCalendar grid pills (CalendarView eventDidMount/
// eventWillUnmount) and agenda rows (AgendaRow mount effect). CalendarView's
// detail-request effect polls it, because the palette's navigation triggers a
// feed refetch — the element may not exist yet when the request lands.
// Unmount sites delete only when still the registered element (a newer mount
// supersedes): `if (detailAnchors.get(key) === el) detailAnchors.delete(key)`.
export const detailAnchors = new Map<string, HTMLElement>()

/** Registry key for a record identity — one format, three writers in lockstep. */
export function anchorKey(calendarUrl: string, uid: string): string {
  return `${calendarUrl}|${uid}`
}

export interface AgendaListProps {
  /** Loaded window length in days, starting today (CalendarView infinite-scroll state). */
  windowDays: number
  /** Bottom sentinel reached → extend the window (+14d; CalendarView-owned state). */
  onExtend: () => void
  /** Section shape (prefs.agendaGroup, 'flat' already mapped to 'day'). */
  group: AgendaGroup
  /** Include todo rows (prefs.agendaTodos). */
  showTodos: boolean
  /** Hash `?q=` search — filters events exactly like the FC feed does. */
  search: string
  /** Event row click → CalendarView's openDetail (EventDetailPopover). */
  onEventClick: (record: EventRecord, el: HTMLElement) => void
  /** Todo row click → CalendarView's openTodoDetail (TodoDetailPopover). */
  onTodoClick: (todo: TodoRecord, el: HTMLElement) => void
}

/**
 * One agenda row: [time] [dot|checkbox] title (CalendarName). Day mode keeps
 * the color dot + calendar suffix; `bare` (kanban column) renders time+title
 * only — the column IS the calendar (todos keep their checkbox either way).
 * `whenLabel` overrides the time cell (undated todos render nothing there).
 */
function AgendaRow(props: {
  item: AgendaItem
  hour12: boolean
  /** Kanban column mode: no dot, no (CalendarName) suffix. */
  bare?: boolean
  whenLabel?: string
  onEventClick: (record: EventRecord, el: HTMLElement) => void
  onTodoClick: (todo: TodoRecord, el: HTMLElement) => void
}) {
  const item = props.item
  const rowRef = useRef<HTMLDivElement | null>(null)
  // Palette→detail bridge: this row's element is the popover anchor for its
  // record (same registry key the FC grid pills use); released on unmount.
  useEffect(() => {
    const key = anchorKey(item.record.calendarUrl, item.record.data.uid)
    const el = rowRef.current
    if (el) detailAnchors.set(key, el)
    return () => {
      if (el && detailAnchors.get(key) === el) detailAnchors.delete(key)
    }
  }, [item.record.key])
  const open = (el: HTMLElement): void => {
    if (item.kind === 'event') props.onEventClick(item.record, el)
    else props.onTodoClick(item.record, el)
  }
  const done = item.kind === 'todo' && isTodoDone(item.record.data)
  return (
    <div
      ref={rowRef}
      class="wycal-agenda-row"
      role="button"
      tabIndex={0}
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        open(e.currentTarget)
      }}
    >
      <span class="wycal-agenda-when tabular-nums">
        {props.whenLabel ?? (item.allDay ? 'All day' : fmtTime(item.when, props.hour12))}
      </span>
      {item.kind === 'event' ? (
        props.bare ? null : (
          <span class="chip-dot shrink-0" style={{ backgroundColor: item.color }} aria-hidden="true" />
        )
      ) : (
        <input
          type="checkbox"
          checked={done}
          onClick={(e) => e.stopPropagation()}
          onChange={() => void toggleDone(item.record)}
          title={done ? 'Mark not done' : 'Mark done'}
          aria-label={done ? `Mark ${item.record.data.summary} not done` : `Mark ${item.record.data.summary} done`}
        />
      )}
      <span class={`wycal-agenda-title${done ? ' todo-done' : ''}`}>{item.record.data.summary}</span>
      {!props.bare && item.calendarName && <span class="wycal-agenda-cal">({item.calendarName})</span>}
    </div>
  )
}

/** Kanban columns show the first KANBAN_ROW_CAP rows; 'Show N more' expands. */
const KANBAN_ROW_CAP = 10

/**
 * One kanban column (§agenda-kanban): a visible calendar as a day-sectioned
 * list, capped at the first KANBAN_ROW_CAP rows until expanded (per-column
 * state). The header is the drag handle: dragover on another header swaps the
 * two columns' order in prefs.calendarOrder (onHeaderDragOver).
 */
function CalColumn(props: {
  name: string
  color?: string
  items: AgendaItem[]
  hour12: boolean
  todayKey: string
  onEventClick: (record: EventRecord, el: HTMLElement) => void
  onTodoClick: (todo: TodoRecord, el: HTMLElement) => void
  onHeaderDragStart: () => void
  onHeaderDragEnd: () => void
  onHeaderDragOver: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const total = props.items.length
  let shown = 0
  const sections = groupByDay(props.items)
    .map((sec) => {
      const take = expanded ? sec.items : sec.items.slice(0, Math.max(0, KANBAN_ROW_CAP - shown))
      shown += take.length
      return { ...sec, items: take }
    })
    .filter((sec) => sec.items.length > 0)
  return (
    <section class="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-(--border)">
      <header
        draggable
        onDragStart={(e) => {
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
          props.onHeaderDragStart()
        }}
        onDragEnd={props.onHeaderDragEnd}
        onDragOver={(e) => {
          e.preventDefault()
          props.onHeaderDragOver()
        }}
        title={`${props.name} — drag to reorder`}
        class="flex cursor-grab items-center gap-2 border-b border-(--border) px-3 py-2 active:cursor-grabbing"
      >
        <span class="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: props.color }} aria-hidden="true" />
        <span class="min-w-0 truncate text-sm font-semibold">{props.name}</span>
        <span class="ml-auto shrink-0 text-xs tabular-nums text-muted">({total})</span>
      </header>
      {sections.map((sec) => (
        <div class="agenda-day" key={sec.key}>
          <header class="agenda-day-head">
            <h2>{agendaDayLabel(sec.key, props.todayKey)}</h2>
            <span class="agenda-day-count tabular-nums">{sec.items.length}</span>
          </header>
          {sec.items.map((item) => (
            <AgendaRow
              key={item.record.key}
              item={item}
              bare
              hour12={props.hour12}
              onEventClick={props.onEventClick}
              onTodoClick={props.onTodoClick}
            />
          ))}
        </div>
      ))}
      {!expanded && total > KANBAN_ROW_CAP && (
        <button
          type="button"
          class="mx-3 mb-3 mt-1 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2"
          onClick={() => setExpanded(true)}
        >
          Show {total - KANBAN_ROW_CAP} more
        </button>
      )}
    </section>
  )
}

/** The agenda view body: grouped sections + rows, or the empty state. */
export function AgendaList(props: AgendaListProps) {
  // Signal reads during render keep the subscription live (MiniAgenda
  // pattern): occurrence buckets, both stores' revisions, visibility, prefs,
  // and the sidebar's agenda filter chips.
  void eventRevision.value
  void todoRevision.value
  void visibilityVersion.value
  const hour12 = prefs.value.hour12
  // Sidebar filter state (§agenda): todos answer to status+priority+tags,
  // events to tags only (see collectAgendaItems).
  const filters = {
    status: agendaFilters.status.value,
    priority: agendaFilters.priority.value,
    tags: agendaFilters.tags.value,
  }
  // prefs.agendaEvents (sidebar write): false hides every event row.
  const showEvents = prefs.value.agendaEvents ?? true

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayKey = dayKey(today)
  const end = addDays(today, props.windowDays)

  // Search filters events exactly like useCalendarEvents: title/location/
  // description, case-insensitive, before the (CalendarName) suffix matters.
  const q = props.search.trim().toLowerCase()
  let events = showEvents ? occurrences({ start: today.toISOString(), end: end.toISOString() }, 'agenda') : []
  if (q) {
    events = events.filter((rec) => {
      const d = rec.data
      return (
        d.summary.toLowerCase().includes(q) ||
        (d.location?.toLowerCase().includes(q) ?? false) ||
        (d.description?.toLowerCase().includes(q) ?? false)
      )
    })
  }
  const todoRecs: TodoRecord[] = []
  if (props.showTodos) {
    for (const rec of todos.value.values()) if (isCalendarVisible(rec.calendarUrl, 'agenda')) todoRecs.push(rec)
  }
  // Ghost todos: no DUE and no DTSTART → collectAgendaItems never places them
  // (the FC feed only emits in-range todos either way), so they come straight
  // from the store and surface as the trailing 'No due date' group below.
  const undated: TodoRecord[] = []
  if (props.showTodos) {
    for (const rec of todoRecs) if (!rec.data.due && !rec.data.dtstart) undated.push(rec)
    undated.sort((a, b) => {
      const sa = a.data.summary
      const sb = b.data.summary
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
  }
  const calInfo = (url: string) => {
    const c = collections.value.find((c) => c.url === url)
    return c ? { name: c.name, color: collectionColor(c) } : undefined
  }
  const items = collectAgendaItems({ today, windowDays: props.windowDays, events, todos: todoRecs, calInfo, filters })

  // §agenda-kanban inputs: visible calendar urls (collection order; the kanban
  // reorders via prefs.calendarOrder) and the drag-reorder swap. The dragged
  // column's url lives in a ref; hovering another header swaps the two in
  // prefs.calendarOrder (persisted via setPrefs). Repeated dragover on the
  // same pair no-ops — after the swap the hovered header IS the dragged one.
  const calUrls = collections.value
    .filter((c) => c.kind === 'calendar' && isCalendarVisible(c.url, 'agenda'))
    .map((c) => c.url)
  const dragUrl = useRef<string | null>(null)
  const swapCalOrder = (target: string): void => {
    const dragged = dragUrl.current
    if (!dragged || dragged === target) return
    const list = orderedCalendars(calUrls, prefs.value.calendarOrder)
    const a = list.indexOf(dragged)
    const b = list.indexOf(target)
    if (a < 0 || b < 0) return
    ;[list[a], list[b]] = [list[b], list[a]]
    setPrefs({ calendarOrder: list })
  }

  // The undated group is a day-grouping feature (kanban columns stay
  // day-sectioned per calendar); it counts toward the empty state only where
  // it actually renders.
  const hasUndatedGroup = props.group !== 'calendar' && undated.length > 0

  let body: JSX.Element | JSX.Element[]
  if (items.length === 0 && !hasUndatedGroup) {
    body = (
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Icon.calendar size={24} />
        <p class="text-sm">Nothing scheduled</p>
      </div>
    )
  } else if (props.group === 'calendar') {
    // §agenda-kanban: one column per visible calendar — prefs.calendarOrder
    // first, then collection order; the sentinel stays at the row bottom.
    const orderedUrls = orderedCalendars(calUrls, prefs.value.calendarOrder)
    const byUrl = new Map(groupByCalendar(items).map((sec): [string, typeof sec] => [sec.url, sec]))
    body = (
      <div class="flex h-full min-h-0 gap-4 overflow-x-auto px-1 pb-1">
        {orderedUrls.map((url) => {
          const cal = collections.value.find((c) => c.url === url)
          const sec = byUrl.get(url)
          return (
            <CalColumn
              key={url}
              name={cal?.name ?? url}
              color={cal ? collectionColor(cal) : undefined}
              items={sec?.items ?? []}
              hour12={hour12}
              todayKey={todayKey}
              onEventClick={props.onEventClick}
              onTodoClick={props.onTodoClick}
              onHeaderDragStart={() => {
                dragUrl.current = url
              }}
              onHeaderDragEnd={() => {
                dragUrl.current = null
              }}
              onHeaderDragOver={() => swapCalOrder(url)}
            />
          )
        })}
      </div>
    )
  } else {
    const sections = groupByDay(items).map((sec) => (
      <section class="agenda-day" key={sec.key}>
        <header class="agenda-day-head">
          <h2>{agendaDayLabel(sec.key, todayKey)}</h2>
          <span class="agenda-day-count tabular-nums">{sec.items.length}</span>
        </header>
        {sec.items.map((item) => (
          <AgendaRow
            key={item.record.key}
            item={item}
            hour12={hour12}
            onEventClick={props.onEventClick}
            onTodoClick={props.onTodoClick}
          />
        ))}
      </section>
    ))
    if (undated.length > 0) {
      // Trailing 'No due date' group, same day-section + row markup as the
      // dated sections; completed undated todos render struck-through muted
      // exactly like dated ones (the agenda never filters completion).
      sections.push(
        <section class="agenda-day" key="undated">
          <header class="agenda-day-head">
            <h2>No due date</h2>
            <span class="agenda-day-count tabular-nums">{undated.length}</span>
          </header>
          {undated.map((rec) => (
            <AgendaRow
              key={rec.key}
              whenLabel=""
              hour12={hour12}
              item={{
                kind: 'todo',
                when: new Date(0), // placeholder — the row renders no time cell
                day: '',
                allDay: true,
                record: rec,
                calendarName: calInfo(rec.calendarUrl)?.name,
                color: calInfo(rec.calendarUrl)?.color,
              }}
              onEventClick={props.onEventClick}
              onTodoClick={props.onTodoClick}
            />
          ))}
        </section>,
      )
    }
    body = sections
  }

  // §agenda infinite scroll: the sentinel hangs after the last section; when
  // it comes within 400px of the viewport the window grows +14d (parent-owned
  // state; the parent resets it on date/group changes). The observer is torn
  // down on unmount, so schedule-mode round-trips start fresh observations.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const onExtend = props.onExtend
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onExtend()
      },
      { rootMargin: '400px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [onExtend])

  return (
    <div class="wycal-agenda h-full overflow-y-auto" aria-label="Agenda">
      {body}
      <div ref={sentinelRef} class="wycal-agenda-sentinel" aria-hidden="true" />
    </div>
  )
}
