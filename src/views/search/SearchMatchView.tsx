/** @jsxImportSource preact */
/**
 * Search row renderers + grouped results (CONTRACTS §15). The `#/search`
 * route and its centered overlay are gone (§nav-revamp): search now lives in
 * the sidebar-top box (`SidebarSearch.tsx`), which reuses everything below —
 * EventRow / TodoRow / SectionHeader / DayHeading / MatchResults over
 * `matchUniverse` (searchEngine.ts). SavedComposite imports the same rows.
 */
import { dayKey, fmtDate, fmtTime } from '../../lib/util/date'
import { prefs } from '../../stores/prefs'
import { toggleDone } from '../../stores/todos'
import type { TodoRecord } from '../../stores/todos'
import { startOfToday } from './searchEngine'
import type { EventItem, MatchItem, TodoItem } from './searchEngine'

// ---------------------------------------------------------------------------
// Row renderers (shared with SavedComposite; design.md §9.4 row anatomy)
// ---------------------------------------------------------------------------

interface EventRowProps {
  when: Date
  allDay: boolean
  title: string
  calName: string
  calColor: string
  hour12: boolean
}

/** Event row: colored dot · time · title · calendar name. */
export function EventRow(props: EventRowProps) {
  return (
    <div class="flex h-8 items-center gap-2 rounded px-2.5 hover:bg-surface-2">
      <span class="chip-dot shrink-0" style={{ background: props.calColor }} />
      <span class="w-16 shrink-0 text-xs tabular-nums text-muted">
        {props.allDay ? 'all-day' : fmtTime(props.when, props.hour12)}
      </span>
      <span class="truncate text-base text-fg-strong">{props.title}</span>
      {props.calName && <span class="ml-auto truncate pl-2 text-sm text-muted">{props.calName}</span>}
    </div>
  )
}

interface TodoRowProps {
  item: TodoItem
  onToggle?: (record: TodoRecord) => void
  onTagClick?: (tag: string) => void
  indented?: boolean
}

/** Task row mirroring TasksView: checkbox, #A/B/C badge, title, tags, due, cal dot. */
export function TodoRow(props: TodoRowProps) {
  const { item } = props
  const onToggle = props.onToggle ?? toggleDone
  const overdue = item.due !== null && !item.done && item.due.getTime() < startOfToday().getTime()
  return (
    <div class="todo-row" style={props.indented ? { paddingLeft: 28 } : undefined}>
      <input
        type="checkbox"
        checked={item.done}
        onChange={() => onToggle(item.record)}
        aria-label={item.done ? `Mark "${item.todo.summary}" not done` : `Mark "${item.todo.summary}" done`}
      />
      {item.prio && <span class={`todo-badge-${item.prio.toLowerCase()}`}>#{item.prio}</span>}
      <span class={item.done ? 'todo-done' : ''}>{item.todo.summary}</span>
      {item.todo.categories.map((tag, i) =>
        props.onTagClick ? (
          <button
            key={`${tag}-${i}`}
            type="button"
            class="tag-chip"
            onClick={() => props.onTagClick?.(tag)}
            title={`Filter by tag "${tag}"`}
          >
            {tag}
          </button>
        ) : (
          <span key={`${tag}-${i}`} class="tag-chip">
            {tag}
          </span>
        ),
      )}
      {item.due && (
        <span class={`ml-auto shrink-0 text-xs tabular-nums ${overdue ? 'text-danger' : 'text-muted'}`}>
          {fmtDate(item.due)}
        </span>
      )}
      <span class="chip-dot shrink-0" style={{ background: item.calColor }} />
      {item.calName && <span class="max-w-32 shrink-0 truncate text-sm text-muted">{item.calName}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grouped results
// ---------------------------------------------------------------------------

/** Section title (design.md §2 --text-md) with a muted count. */
export function SectionHeader(props: { label: string; count: number }) {
  return (
    <h3 class="text-md font-semibold text-fg-strong">
      {props.label}
      <span class="ml-2 text-xs font-normal tabular-nums text-muted">{props.count}</span>
    </h3>
  )
}

/** Day-group header (design.md §9.4: text-xs 600 uppercase muted). */
export function DayHeading(props: { label: string }) {
  return <div class="todo-heading">{props.label}</div>
}

interface DayGroup<T> {
  key: string
  label: string
  items: T[]
}

/** Sort by `when` and group by local day; `when: null` items sink to `undated`. */
function groupByDay<T extends { when: Date | null }>(items: T[]): { groups: DayGroup<T>[]; undated: T[] } {
  const sorted = [...items].sort((a, b) => (a.when?.getTime() ?? Infinity) - (b.when?.getTime() ?? Infinity))
  const groups: DayGroup<T>[] = []
  const index = new Map<string, DayGroup<T>>()
  const undated: T[] = []
  for (const item of sorted) {
    if (!item.when) {
      undated.push(item)
      continue
    }
    const key = dayKey(item.when)
    let group = index.get(key)
    if (!group) {
      group = { key, label: fmtDate(item.when, { weekday: true }), items: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return { groups, undated }
}

/** Grouped search results: Events by start date, Tasks by due date.
 *  `only` renders a single group (sidebar search stacks Contacts between). */
export function MatchResults(props: { items: MatchItem[]; onTagClick?: (tag: string) => void; only?: 'events' | 'todos' }) {
  const hour12 = prefs.value.hour12
  const showEvents = props.only !== 'todos'
  const showTodos = props.only !== 'events'
  const events = groupByDay(props.items.filter((i): i is EventItem => i.kind === 'event'))
  const tasks = groupByDay(props.items.filter((i): i is TodoItem => i.kind === 'todo'))
  return (
    <div class="flex flex-col">
      {showEvents && (
        <>
          <SectionHeader label="Events" count={events.groups.reduce((n, g) => n + g.items.length, 0)} />
          {events.groups.map((g) => (
            <div key={g.key}>
              <DayHeading label={g.label} />
              {g.items.map((it) => (
                <EventRow
                  key={it.record.key}
                  when={it.when}
                  allDay={it.allDay}
                  title={it.ev.summary}
                  calName={it.calName}
                  calColor={it.calColor}
                  hour12={hour12}
                />
              ))}
            </div>
          ))}
          {events.groups.length === 0 && <p class="text-sm text-muted">No matching events.</p>}
        </>
      )}
      {showTodos && (
        <>
          <SectionHeader label="Tasks" count={tasks.groups.reduce((n, g) => n + g.items.length, 0) + tasks.undated.length} />
          {tasks.groups.map((g) => (
            <div key={g.key}>
              <DayHeading label={g.label} />
              {g.items.map((it) => (
                <TodoRow key={it.record.key} item={it} onTagClick={props.onTagClick} />
              ))}
            </div>
          ))}
          {tasks.undated.length > 0 && (
            <div>
              <DayHeading label="No due date" />
              {tasks.undated.map((it) => (
                <TodoRow key={it.record.key} item={it} onTagClick={props.onTagClick} />
              ))}
            </div>
          )}
          {tasks.groups.length === 0 && tasks.undated.length === 0 && <p class="text-sm text-muted">No matching tasks.</p>}
        </>
      )}
    </div>
  )
}

