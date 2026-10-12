/** @jsxImportSource preact */
/**
 * Agenda view list (§agenda): the 'agenda' hash view renders this instead of
 * the FullCalendar host. Same data path as the listAgenda feed in
 * ./useCalendarEvents — occurrences() over the loaded window + todo records
 * of visible calendars, ` (CalendarName)` attribution suffix included —
 * grouped org-super-agenda style. The window is INFINITE: it starts at
 * CalendarView's initial 14 days and grows +14d whenever the bottom sentinel
 * nears the viewport (no range chips). Grouping (Day|Calendar) lives in the
 * toolbar/bottom-bar toggle; todo/event filtering power lives in the sidebar
 * (stores/agendaFilters signals + prefs.agendaEvents), read here via signal
 * values so chip clicks re-render the list.
 *
 * Row contract: muted time column ('All day' for all-day rows), color dot +
 * title for events, a status checkbox for todos (toggleDone in place,
 * completed struck-through muted). Row clicks open the same detail popovers
 * the FC grid uses, via the onEventClick/onTodoClick props CalendarView wires.
 */
import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { addDays, dayKey, fmtTime } from '../../lib/util/date'
import {
  agendaDayLabel,
  agendaShortDay,
  collectAgendaItems,
  groupByCalendar,
  groupByDay,
  type AgendaGroup,
  type AgendaItem,
} from '../../lib/agenda/agendaModel'
import { occurrences, revision as eventRevision, type EventRecord } from '../../stores/events'
import { collectionColor, collections, isCalendarVisible, visibilityVersion } from '../../stores/calendars'
import { isTodoDone, revision as todoRevision, todos, toggleDone, type TodoRecord } from '../../stores/todos'
import { prefs } from '../../stores/prefs'
import { agendaFilters } from '../../stores/agendaFilters' // sidebar filter chips (N1): status/priority computed, tags signal
import { Icon } from '../../ui/icons'

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

/** One agenda row: [day tag] [time] [dot|checkbox] title (CalendarName). */
function AgendaRow(props: {
  item: AgendaItem
  hour12: boolean
  /** Calendar grouping labels every row with its day ('Mon 13'). */
  showDay: boolean
  onEventClick: (record: EventRecord, el: HTMLElement) => void
  onTodoClick: (todo: TodoRecord, el: HTMLElement) => void
}) {
  const item = props.item
  const open = (el: HTMLElement): void => {
    if (item.kind === 'event') props.onEventClick(item.record, el)
    else props.onTodoClick(item.record, el)
  }
  const done = item.kind === 'todo' && isTodoDone(item.record.data)
  return (
    <div
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
      {props.showDay && <span class="wycal-agenda-when tabular-nums">{agendaShortDay(item.day)}</span>}
      <span class="wycal-agenda-when tabular-nums">{item.allDay ? 'All day' : fmtTime(item.when, props.hour12)}</span>
      {item.kind === 'event' ? (
        <span class="chip-dot shrink-0" style={{ backgroundColor: item.color }} aria-hidden="true" />
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
      {item.calendarName && <span class="wycal-agenda-cal">({item.calendarName})</span>}
    </div>
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
  let events = showEvents ? occurrences({ start: today.toISOString(), end: end.toISOString() }) : []
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
    for (const rec of todos.value.values()) if (isCalendarVisible(rec.calendarUrl)) todoRecs.push(rec)
  }
  const calInfo = (url: string) => {
    const c = collections.value.find((c) => c.url === url)
    return c ? { name: c.name, color: collectionColor(c) } : undefined
  }
  const items = collectAgendaItems({ today, windowDays: props.windowDays, events, todos: todoRecs, calInfo, filters })
  const rowProps = { hour12, onEventClick: props.onEventClick, onTodoClick: props.onTodoClick }

  let body: JSX.Element | JSX.Element[]
  if (items.length === 0) {
    body = (
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Icon.calendar size={24} />
        <p class="text-sm">Nothing scheduled</p>
      </div>
    )
  } else if (props.group === 'calendar') {
    body = groupByCalendar(items).map((sec) => (
      <section class="agenda-day" key={sec.url}>
        <header class="agenda-cal-head">
          <span class="chip-dot shrink-0" style={{ backgroundColor: sec.color }} title={sec.name} />
          <span class="agenda-cal-name">{sec.name}</span>
          <span class="agenda-cal-count tabular-nums">({sec.items.length})</span>
        </header>
        {sec.items.map((item) => (
          <AgendaRow key={item.record.key} item={item} showDay {...rowProps} />
        ))}
      </section>
    ))
  } else {
    body = groupByDay(items).map((sec) => (
      <section class="agenda-day" key={sec.key}>
        <header class="agenda-day-head">
          <h2>{agendaDayLabel(sec.key, todayKey)}</h2>
          <span class="agenda-day-count tabular-nums">{sec.items.length}</span>
        </header>
        {sec.items.map((item) => (
          <AgendaRow key={item.record.key} item={item} showDay={false} {...rowProps} />
        ))}
      </section>
    ))
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
