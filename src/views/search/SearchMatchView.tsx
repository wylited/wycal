/** @jsxImportSource preact */
/**
 * Search view (CONTRACTS §15): `#/search?q=…` — big query input (autofocus,
 * prefilled from `?q=`), chip hint row, grouped results (Events by start
 * date, Tasks by due), `Save as view` → savedviews + toast.
 *
 * Query grammar, matching and store collection live in searchEngine.ts.
 * Row renderers + grouped results here are reused by SavedComposite.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { dayKey, fmtDate, fmtTime } from '../../lib/util/date'
import { prefs } from '../../stores/prefs'
import { push } from '../../stores/toasts'
import { saveView } from '../../stores/savedviews'
import { toggleDone } from '../../stores/todos'
import type { TodoRecord } from '../../stores/todos'
import { parseRoutePath, useHash } from '../../routes'
import { filterMatchItems, matchUniverse, startOfToday, tokenToText, tokenizeQuery } from './searchEngine'
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

/** Grouped search results: Events by start date, Tasks by due date. */
export function MatchResults(props: { items: MatchItem[]; onTagClick?: (tag: string) => void }) {
  const hour12 = prefs.value.hour12
  const events = groupByDay(props.items.filter((i): i is EventItem => i.kind === 'event'))
  const tasks = groupByDay(props.items.filter((i): i is TodoItem => i.kind === 'todo'))
  return (
    <div class="flex flex-col">
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search view
// ---------------------------------------------------------------------------

const HINTS: Array<{ label: string; insert: string; title: string }> = [
  { label: 'tag:', insert: 'tag:', title: 'Filter by a tag — tag:home' },
  { label: 'cal:', insert: 'cal:', title: 'Filter by calendar name — cal:work' },
  { label: 'prio:A', insert: 'prio:A', title: 'Priority letter prio:A|B|C (tasks only)' },
  { label: 'due:7d', insert: 'due:7d', title: 'Due or starting within N days — due:7d' },
  { label: 'done:false', insert: 'done:false', title: 'Task completion — done:true|false (tasks only)' },
  { label: '/regex/', insert: '/', title: 'Case-insensitive regular expression over title, notes and tags' },
]

/** `#/search` — big query input, hint chips, grouped results, Save as view. */
export default function SearchMatchView() {
  const hash = useHash()
  const { query } = parseRoutePath(hash.replace(/^#/, ''))
  const q = query.get('q') ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [debouncedDraft, setDebouncedDraft] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // External `?q=` navigation takes over the input again.
  useEffect(() => {
    setDraft(null)
    setDebouncedDraft(null)
    setNaming(false)
  }, [q])
  useEffect(() => {
    if (naming) nameRef.current?.focus()
  }, [naming])

  // ~150ms debounce (perf P5): the input mirrors `draft` instantly, while
  // tokenizing + filtering run on the settled value only.
  useEffect(() => {
    if (draft === null) return
    const t = window.setTimeout(() => setDebouncedDraft(draft), 150)
    return () => window.clearTimeout(t)
  }, [draft])

  const value = draft ?? q
  const evaluated = debouncedDraft ?? q
  const { tokens, error } = tokenizeQuery(evaluated)
  const results = error || !evaluated.trim() ? [] : filterMatchItems(matchUniverse.value, tokens)
  const canSave = !error && evaluated.trim().length > 0

  function appendToken(insert: string): void {
    const base = value.trimEnd()
    setDraft(base ? `${base} ${insert}` : insert)
  }

  /** Tag chip click: swap in `tag:<x>` keeping every other token. */
  function setTagToken(tag: string): void {
    const kept = tokenizeQuery(value).tokens.filter((t) => t.kind !== 'tag').map(tokenToText)
    kept.push(`tag:${tag}`)
    setDraft(kept.join(' '))
  }

  function save(): void {
    const trimmed = name.trim()
    if (!trimmed || !canSave) return
    saveView({ name: trimmed, sections: [{ type: 'match', query: evaluated }] })
    push('success', `View "${trimmed}" saved`)
    setName('')
    setNaming(false)
  }

  return (
    <div class="flex w-full flex-col gap-3 overflow-y-auto p-4">
      <h2 class="text-lg font-semibold text-fg-strong">Search</h2>
      <input
        ref={inputRef}
        class="input"
        type="search"
        autoFocus
        value={value}
        placeholder="Search events and tasks — tag:x cal:x prio:A due:7d done:false /regex/ text"
        aria-label="Search events and tasks"
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <div class="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Search syntax hints">
        {HINTS.map((hint) => (
          <button
            key={hint.label}
            type="button"
            class="chip hint-chip"
            title={hint.title}
            onClick={() => {
              appendToken(hint.insert)
              inputRef.current?.focus()
            }}
          >
            {hint.label}
          </button>
        ))}
        <span class="text-xs text-muted" title="Plain words match title, location, notes and tags">
          text
        </span>
      </div>
      {error && (
        <p class="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {naming ? (
        <div class="flex items-center gap-2">
          <input
            ref={nameRef}
            class="input"
            style={{ maxWidth: 280 }}
            value={name}
            placeholder="View name"
            aria-label="View name"
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              else if (e.key === 'Escape') {
                setNaming(false)
                setName('')
              }
            }}
          />
          <button type="button" class="btn btn-primary btn-sm" onClick={save} disabled={!name.trim()}>
            Save
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => {
              setNaming(false)
              setName('')
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            class="btn btn-sm"
            disabled={!canSave}
            title={canSave ? 'Save this query as a saved view' : 'Type a query first'}
            onClick={() => setNaming(true)}
          >
            Save as view
          </button>
        </div>
      )}
      {results.length > 0 ? (
        <MatchResults items={results} onTagClick={setTagToken} />
      ) : (
        <p class="text-sm text-muted">
          {error ? 'Fix the query error above to see results.' : evaluated.trim() ? 'No matches.' : 'Type to search events and tasks.'}
        </p>
      )}
    </div>
  )
}
