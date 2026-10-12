/**
 * Pure agenda model (§agenda): the grouping layer behind AgendaList. No
 * signal reads and no preact — callers feed it the same inputs the
 * listAgenda FullCalendar feed gets (occurrences() output + todo records of
 * visible calendars) plus a calendar-name/color lookup and the sidebar's
 * agenda filter state, and get back sorted items shaped for the agenda
 * groupings ('day' | 'calendar'; legacy stored 'flat' is mapped to 'day'
 * before it reaches here).
 *
 * Ordering contract (shared by every grouping): by local day, then all-day
 * rows before timed rows (FullCalendar list parity), then by start instant,
 * then summary — so both day sections and flat lists read identically.
 */
import type { EventRecord } from '../../stores/events'
import type { TodoRecord } from '../../stores/todos'
import { icsDateToDate, type IcsTodo } from '../../lib/ics/types'
import { addDays, dayKey, fmtDate } from '../../lib/util/date'

/** Legacy stored agenda window presets (prefs.agendaRange). The agenda is
 *  infinite now (§agenda): the UI never reads this pref — it survives only so
 *  old stored values keep validating. */
export type AgendaRange = 7 | 14 | 30

/** Agenda grouping modes (prefs.agendaGroup; CalendarView group chips). */
export type AgendaGroup = 'day' | 'calendar' | 'flat'

/** One agenda row's calendar attribution (name suffix + dot color). */
export interface AgendaCalInfo {
  name?: string
  color?: string
}

interface AgendaBase {
  /** Placement instant (local). A todo's due, else its dtstart. */
  when: Date
  /** Local 'YYYY-MM-DD' of `when` (grouping key). */
  day: string
  /** All-day rows render 'All day' in the time column and sort first. */
  allDay: boolean
  calendarName?: string
  color?: string
}

export interface AgendaEventItem extends AgendaBase {
  kind: 'event'
  record: EventRecord
}

export interface AgendaTodoItem extends AgendaBase {
  kind: 'todo'
  /** Todos ride the all-day lane in the FC list (§15) — always true here. */
  allDay: true
  record: TodoRecord
}

export type AgendaItem = AgendaEventItem | AgendaTodoItem

/** 'Today · Sun Oct 12' / 'Mon Oct 13' — sticky day-header label. */
export function agendaDayLabel(day: string, todayKey: string): string {
  const label = fmtDate(new Date(`${day}T00:00:00`), { weekday: true })
  return day === todayKey ? `Today · ${label}` : label
}

/** Compact in-row day tag for the calendar grouping: 'Mon 13'. */
export function agendaShortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`
}

/** Shared row order: day, then all-day first, then instant, then summary. */
function compareItems(a: AgendaItem, b: AgendaItem): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  if (a.when.getTime() !== b.when.getTime()) return a.when.getTime() - b.when.getTime()
  const sa = a.record.data.summary
  const sb = b.record.data.summary
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export interface CollectAgendaArgs {
  /** Local midnight of the first agenda day (the window anchor). */
  today: Date
  /** Loaded window length in days ([today, today + windowDays)); the caller
   *  grows it for the infinite scroll (§agenda). */
  windowDays: number
  /** occurrences() output for the window (already visibility-filtered). */
  events: readonly EventRecord[]
  /** Todo records of visible calendars (visibility is the caller's gate). */
  todos: readonly TodoRecord[]
  /** Calendar attribution lookup (collections store read at the caller). */
  calInfo: (calendarUrl: string) => AgendaCalInfo | undefined
  /** Sidebar filter state (stores/agendaFilters signals, read at the caller). */
  filters: AgendaFilterState
}

/** Sidebar todo-filter state (§agenda filters; stores/agendaFilters signals):
 *  status gates VTODO STATUS, priority gates PRIORITY bands (A=1–3, B=4–6,
 *  C=7–9), tags gate CATEGORIES as a superset match (every selected tag
 *  present; empty = no tag gate). Events answer to tags only. */
export interface AgendaFilterState {
  status: 'all' | 'todo' | 'doing' | 'done'
  priority: 'all' | 'A' | 'B' | 'C'
  tags: string[]
}

/** Sidebar status chip → the VTODO STATUS value it keeps. */
const STATUS_FILTER: Record<Exclude<AgendaFilterState['status'], 'all'>, IcsTodo['status']> = {
  todo: 'NEEDS-ACTION',
  doing: 'IN-PROCESS',
  done: 'COMPLETED',
}

/**
 * Flatten + window + sort the agenda inputs. An event is placed at its start
 * instant (multi-day events appear once, at their first day — FullCalendar
 * list parity); items outside [today, today + range) are dropped.
 */
export function collectAgendaItems(args: CollectAgendaArgs): AgendaItem[] {
  const { today, windowDays, events, todos, calInfo, filters } = args
  const startMs = today.getTime()
  const endMs = addDays(today, windowDays).getTime()
  const wantStatus = filters.status === 'all' ? null : STATUS_FILTER[filters.status]
  const wantTags = filters.tags.length > 0
  // Superset match: every selected tag must appear in the item's CATEGORIES.
  const tagsOk = (cats: readonly string[]): boolean => !wantTags || filters.tags.every((t) => cats.includes(t))
  const bandOk = (p: number | undefined): boolean => {
    if (filters.priority === 'all') return true
    if (p === undefined) return false
    return filters.priority === (p <= 3 ? 'A' : p <= 6 ? 'B' : 'C')
  }
  const items: AgendaItem[] = []
  for (const rec of events) {
    const when = icsDateToDate(rec.data.start)
    const t = when.getTime()
    if (t < startMs || t >= endMs) continue
    if (!tagsOk(rec.data.categories)) continue // events: tag gate only
    const info = calInfo(rec.calendarUrl)
    items.push({
      kind: 'event',
      when,
      day: dayKey(when),
      allDay: rec.data.allDay,
      record: rec,
      calendarName: info?.name,
      color: info?.color,
    })
  }
  // The todo's agenda placement instant is its due, else dtstart (§15); todos
  // ride the all-day lane in the FC list, so they stay allDay here too.
  for (const rec of todos) {
    const when = rec.data.due ? icsDateToDate(rec.data.due) : rec.data.dtstart ? icsDateToDate(rec.data.dtstart) : null
    if (!when) continue
    const t = when.getTime()
    if (t < startMs || t >= endMs) continue
    if (wantStatus !== null && rec.data.status !== wantStatus) continue
    if (!bandOk(rec.data.priority)) continue
    if (!tagsOk(rec.data.categories)) continue
    const info = calInfo(rec.calendarUrl)
    items.push({
      kind: 'todo',
      when,
      day: dayKey(when),
      allDay: true,
      record: rec,
      calendarName: info?.name,
      color: info?.color,
    })
  }
  return items.sort(compareItems)
}

export interface AgendaDaySection {
  /** Local 'YYYY-MM-DD' (section key). */
  key: string
  items: AgendaItem[]
}

/** 'day' grouping: chronological day sections; empty sections never form. */
export function groupByDay(items: readonly AgendaItem[]): AgendaDaySection[] {
  const out: AgendaDaySection[] = []
  let cur: AgendaDaySection | null = null
  for (const item of items) {
    if (!cur || cur.key !== item.day) {
      cur = { key: item.day, items: [] }
      out.push(cur)
    }
    cur.items.push(item)
  }
  return out
}

export interface AgendaCalSection {
  /** Collection URL (section key). */
  url: string
  name: string
  color?: string
  items: AgendaItem[]
}

/** 'calendar' grouping: one section per calendar, rows chronological inside. */
export function groupByCalendar(items: readonly AgendaItem[]): AgendaCalSection[] {
  const byUrl = new Map<string, AgendaCalSection>()
  for (const item of items) {
    const url = item.record.calendarUrl
    let sec = byUrl.get(url)
    if (!sec) {
      sec = { url, name: item.calendarName ?? url, color: item.color, items: [] }
      byUrl.set(url, sec)
    }
    sec.items.push(item)
  }
  return [...byUrl.values()]
}
