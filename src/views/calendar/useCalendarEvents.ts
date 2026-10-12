/**
 * Store → FullCalendar event feed (CONTRACTS §5, §15; local://wycal-research.md §1.7).
 *
 * The `events` callback is a *function source*: FullCalendar re-invokes it on
 * visible-range changes and on `calendarApi.refetchEvents()` — never on store
 * mutations. The hook therefore also subscribes to the signals that change the
 * result set (event+todo revisions, calendar visibility) and refetches
 * explicitly; a new search term refilters the feed the same way (research §1.7).
 *
 * The feed always emits the visible todos whose due (else dtstart) falls
 * inside the fetched range as all-day `▢ …` events carrying
 * `extendedProps.todo` (CONTRACTS §15), colored via `eventColorFor` (§14
 * order: todo color → calendar default → collection): listAgenda rows add
 * ` (Name)`; grid views land them in the dayGrid all-day lane.
 */
import { useCallback, useEffect, useRef } from 'preact/hooks'
import type { CalendarApi, EventInput } from '@fullcalendar/core'
import { effect } from '@preact/signals'
import { occurrences, revision, type EventRecord } from '../../stores/events'
import { collectionColor, collections, isCalendarVisible, visibilityVersion } from '../../stores/calendars'
import { todos, revision as todoRevision, type TodoRecord } from '../../stores/todos'
import { eventColorFor } from '../../lib/util/colors'
import { icsDateToDate } from '../../lib/ics/types'

/** Args FullCalendar passes to a function event source. */
interface FetchInfo {
  start: Date
  end: Date
  startStr: string
  endStr: string
  timeZone: string
}

type CalendarEventsFn = (
  info: FetchInfo,
  success: (events: EventInput[]) => void,
  failure: (error: Error) => void,
) => void

/** EventRecord → FullCalendar EventInput (CONTRACTS §5 field mapping).
 *  `inList` (agenda/list view only, §22): the calendar's sidebar display
 *  name is appended to the title as ` (Name)` so agenda rows stay attributable;
 *  grid views keep the bare summary. */
function toFcEvent(rec: EventRecord, inList: boolean): EventInput {
  const collection = collections.value.find((c) => c.url === rec.calendarUrl)
  const color = collection ? collectionColor(collection) : undefined
  const start = icsDateToDate(rec.data.start)
  const end = rec.data.end ? icsDateToDate(rec.data.end) : undefined
  // TIMED occurrences spanning ≥ 24h would render as tall full-column blocks
  // colliding with pills — display them as all-day bars instead. Only the
  // display flag flips: extendedProps.record keeps the true times, so the
  // editor and stores still see them. TRUE all-day events are excluded: their
  // DTEND is already an exclusive midnight (a 1-day event spans exactly 24h),
  // and FullCalendar treats an all-day `end` as exclusive too, so it passes
  // through unchanged — re-rounding it stretched birthdays to 2 days. For the
  // timed case the end is inclusive, so round the display end up to the next
  // midnight — a Fri-17:00 end must still cover Friday's cell.
  const spansDays = !rec.data.allDay && end !== undefined && end.getTime() - start.getTime() >= 86_400_000
  let displayEnd = end
  if (spansDays && end !== undefined) {
    displayEnd = new Date(end)
    displayEnd.setHours(0, 0, 0, 0)
    displayEnd.setDate(displayEnd.getDate() + 1)
  }
  return {
    id: rec.key,
    groupId: rec.data.uid,
    title: inList && collection?.name ? `${rec.data.summary} (${collection.name})` : rec.data.summary,
    start,
    end: displayEnd,
    allDay: rec.data.allDay || spansDays,
    // Chrome (soft fill + left bar) is painted by CSS from this color via
    // eventDidMount (CalendarView) — no per-event backgroundColor/borderColor.
    extendedProps: { record: rec, color },
  }
}

/** The todo's agenda placement instant: due, else dtstart. */
function todoWhen(rec: TodoRecord): Date | null {
  return rec.data.due ? icsDateToDate(rec.data.due) : rec.data.dtstart ? icsDateToDate(rec.data.dtstart) : null
}

/** TodoRecord → all-day `▢ title` row on its due/dtstart (§15).
 *  `inList` (listAgenda only, §22): the calendar's sidebar display name is
 *  appended as ` (Name)`; grid views keep the bare `▢ summary` in the
 *  all-day lane, keyed `todo:<key>` with extendedProps.todo so CalendarView
 *  can route clicks. */
function toFcTodo(rec: TodoRecord, inList: boolean): EventInput {
  const name = inList ? collections.value.find((c) => c.url === rec.calendarUrl)?.name : undefined
  return {
    // `todo:` prefix keeps ids disjoint from event record keys.
    id: `todo:${rec.key}`,
    title: `▢ ${rec.data.summary}${name ? ` (${name})` : ''}`,
    allDay: true,
    start: todoWhen(rec) ?? undefined,
    extendedProps: {
      todo: rec,
      color: eventColorFor({ color: rec.data.color, calendarUrl: rec.calendarUrl }),
    },
  }
}

/**
 * Events feed for the `<FullCalendar>` host. `search` (the `?q=` hash param)
 * filters title/location/description case-insensitively; todos are emitted in
 * every view (§15): `includeTodos` marks the listAgenda feed, whose rows add
 * ` (CalendarName)` to titles (§22) — grid views keep the bare `▢ summary`
 * in the all-day lane.
 */
export function useCalendarEvents(
  getApi: () => CalendarApi | null,
  search: string,
  includeTodos: boolean,
): CalendarEventsFn {
  const searchRef = useRef(search)
  searchRef.current = search
  const includeTodosRef = useRef(includeTodos)
  includeTodosRef.current = includeTodos

  const events = useCallback<CalendarEventsFn>((info, success, failure) => {
    try {
      const q = searchRef.current.trim().toLowerCase()
      const recs = occurrences({
        start: info.start.toISOString(),
        end: info.end.toISOString(),
      })
      // Case-insensitive search over title/location/description.
      const filtered = q
        ? recs.filter((rec) => {
            const d = rec.data
            return (
              d.summary.toLowerCase().includes(q) ||
              (d.location?.toLowerCase().includes(q) ?? false) ||
              (d.description?.toLowerCase().includes(q) ?? false)
            )
          })
        : recs
      // The suffix path (includeTodos doubles as the listAgenda indicator —
      // CalendarView passes fcView === 'listAgenda') appends ` (CalendarName)`
      // AFTER filtering, so search still matches the bare summary.
      const out: EventInput[] = filtered.map((rec) => toFcEvent(rec, includeTodosRef.current))
      // Todos ride the same visibility + range gates in every view. listAgenda
      // (includeTodos doubles as the listAgenda indicator — CalendarView passes
      // fcView === 'listAgenda') keeps §15: `▢ title (CalendarName)` rows.
      // Grid views (includeTodos false) emit the compact `▢ summary` all-day
      // events that land in the dayGrid all-day lane; extendedProps.todo lets
      // CalendarView route their clicks.
      for (const rec of todos.value.values()) {
        if (!isCalendarVisible(rec.calendarUrl)) continue
        const when = todoWhen(rec)
        if (!when) continue
        if (when.getTime() >= info.start.getTime() && when.getTime() < info.end.getTime()) {
          out.push(toFcTodo(rec, includeTodosRef.current))
        }
      }
      success(out)
    } catch (err) {
      failure(err instanceof Error ? err : new Error(String(err)))
    }
  }, [])

  // Store mutations bump a revision without FullCalendar knowing; visibility
  // changes reshape the result set the same way. Refetch on all three —
  // debounced so boot's per-collection revision bumps and sync deltas
  // collapse into one refetch. The effect body runs once at setup (signal
  // subscription); FullCalendar has already done its initial fetch by then,
  // so that first run is skipped.
  useEffect(() => {
    let first = true
    let timer: number | undefined
    const dispose = effect(() => {
      revision.value
      todoRevision.value
      visibilityVersion.value
      if (first) {
        first = false
        return
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        getApi()?.refetchEvents()
      }, 120)
    })
    return () => {
      dispose()
      window.clearTimeout(timer)
    }
  }, [getApi])

  const firstSearchRun = useRef(true)
  useEffect(() => {
    // Skip the mount-time refetch for the same reason: the initial fetch
    // already ran with the current search/todo settings.
    if (firstSearchRun.current) {
      firstSearchRun.current = false
      return
    }
    getApi()?.refetchEvents()
  }, [search, includeTodos, getApi])

  return events
}
