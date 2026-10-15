/** @jsxImportSource preact */
/**
 * Saved composite view renderer (CONTRACTS §15).
 *
 * Renders a SavedView (stores/savedviews) as vertically stacked sections:
 *   agenda — day-grouped list rows over event occurrences in its `days`
 *            window (todos whose due/dtstart falls on the day appended as
 *            `▢ title` rows), optionally scoped to `calendars`;
 *   todos  — TasksView-style rows with the section's status/tag/calendar
 *            filter, children indented one level via relatedTo;
 *   match  — search results for the section's saved query.
 *
 * Mounted at `#/view/:id` (route props) and also accepts the calendar
 * route's `?saved=<id>` hash query.
 */
import { addDays, dayKey, fmtDate } from '@wycal/core/lib/util/date'
import { icsDateToDate } from '@wycal/core/lib/ics/types'
import { collectionColor, collections, visibleCalendars } from '@wycal/core/stores/calendars'
import { occurrences } from '@wycal/core/stores/events'
import type { EventRecord } from '@wycal/core/stores/events'
import { prefs } from '@wycal/core/stores/prefs'
import { parseRoutePath, useHash } from '../../routes'
import { savedViews } from '../../stores/savedviews'
import type { SavedView } from '../../stores/savedviews'
import { stuckTopLevel, todos as todosSignal } from '@wycal/core/stores/todos'
import type { TodoRecord } from '@wycal/core/stores/todos'
import { DayHeading, EventRow, MatchResults, SectionHeader, TodoRow } from './SearchMatchView'
import { collectMatchItems, collectTodoItems, filterMatchItems, startOfToday, tokenizeQuery } from '@wycal/core/search/searchEngine'
import type { TodoItem } from '@wycal/core/search/searchEngine'

type SavedSection = SavedView['sections'][number]

interface AgendaEntry {
  rec: EventRecord
  calName: string
  calColor: string
}

// ---------------------------------------------------------------------------
// Agenda section
// ---------------------------------------------------------------------------

/** Day-grouped list: events (EventRow) then `▢ title` todo rows per day. */
function AgendaSection(props: { section: Extract<SavedSection, { type: 'agenda' }> }) {
  const hour12 = prefs.value.hour12
  const today = startOfToday()
  const end = addDays(today, props.section.days + 1)
  const cals = props.section.calendars
  const inScope = (url: string) => !cals || cals.includes(url)
  const cols = new Map(collections.value.map((c) => [c.url, c]))
  const info = (url: string) => {
    const col = cols.get(url)
    return { name: col?.name ?? '', color: col ? collectionColor(col) : 'var(--muted)' }
  }

  interface Bucket {
    label: string
    events: AgendaEntry[]
    todos: Array<{ rec: TodoRecord; calName: string }>
  }
  const buckets = new Map<string, Bucket>()
  const bucketFor = (d: Date): Bucket => {
    const key = dayKey(d)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { label: fmtDate(d, { weekday: true }), events: [], todos: [] }
      buckets.set(key, bucket)
    }
    return bucket
  }

  for (const rec of occurrences({ start: today.toISOString(), end: end.toISOString() })) {
    if (!inScope(rec.calendarUrl)) continue
    const { name, color } = info(rec.calendarUrl)
    bucketFor(icsDateToDate(rec.data.start)).events.push({ rec, calName: name, calColor: color })
  }
  for (const rec of todosSignal.value.values()) {
    if (!visibleCalendars.value.has(rec.calendarUrl) || !inScope(rec.calendarUrl)) continue
    const when = rec.data.due ?? rec.data.dtstart
    if (!when) continue
    const d = icsDateToDate(when)
    if (d.getTime() < today.getTime() || d.getTime() >= end.getTime()) continue
    bucketFor(d).todos.push({ rec, calName: info(rec.calendarUrl).name })
  }

  const days = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const total = days.reduce((n, [, b]) => n + b.events.length + b.todos.length, 0)

  return (
    <section class="flex flex-col gap-1">
      <SectionHeader label="Agenda" count={total} />
      {total === 0 && <p class="text-sm text-muted">Nothing scheduled in the next {props.section.days} days.</p>}
      {days.map(([key, bucket]) => (
        <div key={key}>
          <DayHeading label={bucket.label} />
          {bucket.events.map((e) => (
            <EventRow
              key={e.rec.key}
              when={icsDateToDate(e.rec.data.start)}
              allDay={e.rec.data.allDay}
              title={e.rec.data.summary}
              calName={e.calName}
              calColor={e.calColor}
              hour12={hour12}
            />
          ))}
          {bucket.todos.map((t) => {
            const done = t.rec.data.status === 'COMPLETED'
            return (
              <div key={t.rec.key} class="todo-row">
                <span aria-hidden="true">▢</span>
                <span class={done ? 'todo-done' : ''}>{t.rec.data.summary}</span>
                {t.calName && <span class="ml-auto truncate pl-2 text-sm text-muted">{t.calName}</span>}
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Todos section
// ---------------------------------------------------------------------------

const PRIO_RANK: Record<'A' | 'B' | 'C', number> = { A: 0, B: 1, C: 2 }

function compareTodos(a: TodoItem, b: TodoItem): number {
  const ra = a.prio ? PRIO_RANK[a.prio] : 3
  const rb = b.prio ? PRIO_RANK[b.prio] : 3
  if (ra !== rb) return ra - rb
  const da = a.due?.getTime() ?? Infinity
  const db = b.due?.getTime() ?? Infinity
  if (da !== db) return da - db
  return a.todo.summary.localeCompare(b.todo.summary)
}

/** TasksView-style filtered rows; children (relatedTo) indent one level. */
function TodosSection(props: { section: Extract<SavedSection, { type: 'todos' }> }) {
  const filter = props.section.filter
  const stuckKeys = filter.status === 'stuck' ? new Set(stuckTopLevel().map((t) => t.key)) : null
  const items = collectTodoItems().filter((it) => {
    if (filter.calendar && it.calUrl !== filter.calendar) return false
    if (filter.tag) {
      const want = filter.tag.toLowerCase()
      if (!it.categories.some((c) => c.toLowerCase() === want)) return false
    }
    if (filter.status === 'open' && it.done) return false
    if (filter.status === 'done' && !it.done) return false
    if (filter.status === 'stuck' && stuckKeys !== null && !stuckKeys.has(it.record.key)) return false
    return true
  })
  items.sort(compareTodos)

  // relatedTo is a parent todo uid; children of parents outside the filtered
  // set surface at top level. Descendants render indented (one level).
  const byUid = new Map(items.map((it) => [it.todo.uid, it]))
  const childrenOf = new Map<string, TodoItem[]>()
  const top: TodoItem[] = []
  for (const it of items) {
    const parent = it.todo.relatedTo
    if (parent && byUid.has(parent)) {
      const list = childrenOf.get(parent) ?? []
      list.push(it)
      childrenOf.set(parent, list)
    } else {
      top.push(it)
    }
  }
  const rows: Array<{ item: TodoItem; indented: boolean }> = []
  const walk = (item: TodoItem, indented: boolean) => {
    rows.push({ item, indented })
    for (const child of childrenOf.get(item.todo.uid) ?? []) walk(child, true)
  }
  for (const t of top) walk(t, false)

  return (
    <section class="flex flex-col gap-1">
      <SectionHeader label="Tasks" count={rows.length} />
      {rows.length === 0 && <p class="text-sm text-muted">No tasks match this filter.</p>}
      {rows.map(({ item, indented }) => (
        <TodoRow key={item.record.key} item={item} indented={indented} />
      ))}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Match section
// ---------------------------------------------------------------------------

/** Saved query re-evaluated over the same universe as the search view. */
function MatchSection(props: { section: Extract<SavedSection, { type: 'match' }> }) {
  const { tokens, error } = tokenizeQuery(props.section.query)
  if (error) {
    return (
      <section class="flex flex-col gap-1">
        <SectionHeader label="Search" count={0} />
        <p class="text-sm text-danger" role="alert">
          {error}
        </p>
      </section>
    )
  }
  const results = filterMatchItems(collectMatchItems(), tokens)
  return (
    <section class="flex flex-col gap-1">
      <SectionHeader label="Search" count={results.length} />
      {results.length === 0 ? (
        <p class="text-sm text-muted">No matches.</p>
      ) : (
        <MatchResults items={results} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/**
 * Render one SavedView's sections stacked. `#/view/:id` passes `id` as a
 * route prop; the calendar route embeds via `?saved=<id>` in the hash.
 */
export default function SavedComposite(props: { id?: string; savedId?: string }) {
  const hash = useHash()
  const { query } = parseRoutePath(hash.replace(/^#/, ''))
  const id = props.id ?? props.savedId ?? query.get('saved') ?? ''
  const view = savedViews.value.find((v) => v.id === id)

  if (!view) {
    return (
      <div class="p-4">
        <h2 class="text-lg font-semibold text-fg-strong">Saved view</h2>
        <p class="mt-2 text-sm text-muted">This saved view no longer exists.</p>
      </div>
    )
  }

  return (
    <div class="flex w-full flex-col gap-5 overflow-y-auto p-4">
      <h2 class="text-lg font-semibold text-fg-strong">{view.name}</h2>
      {view.sections.map((section, i) => {
        if (section.type === 'agenda') return <AgendaSection key={i} section={section} />
        if (section.type === 'todos') return <TodosSection key={i} section={section} />
        return <MatchSection key={i} section={section} />
      })}
    </div>
  )
}
