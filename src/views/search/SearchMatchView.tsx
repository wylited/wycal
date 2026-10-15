/** @jsxImportSource preact */
/**
 * Search row renderers + grouped results (CONTRACTS §15). The `#/search`
 * route and its centered overlay are gone (§nav-revamp): search now lives in
 * the sidebar-top box (`SidebarSearch.tsx`), which reuses everything below —
 * EventRow / TodoRow / SectionHeader / DayHeading / MatchResults over
 * `matchUniverse` (searchEngine.ts), plus the RowDetail / DetailField /
 * snippet card building blocks (SidebarSearch's contact rows use them too).
 * Expansion is opt-in: rows without a `detail` prop (SavedComposite) and
 * MatchResults without `expandable` render exactly as before.
 */
import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { addDays, dayKey, fmtDate, fmtTime } from '@wycal/core/lib/util/date'
import { icsDateToDate } from '@wycal/core/lib/ics/types'
import { prefs } from '@wycal/core/stores/prefs'
import { toggleDone } from '@wycal/core/stores/todos'
import type { TodoRecord } from '@wycal/core/stores/todos'
import { startOfToday } from '@wycal/core/search/searchEngine'
import type { EventItem, MatchItem, TodoItem } from '@wycal/core/search/searchEngine'

// ---------------------------------------------------------------------------
// Row renderers (shared with SavedComposite; design.md §9.4 row anatomy)
// ---------------------------------------------------------------------------

/** ~200-char clamp for description/note snippets in the detail cards. */
const SNIPPET_MAX = 200

/** First ~200 chars of a longer text, trimmed, ellipsis when clamped. */
export function snippet(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed
}

/** Labeled detail line (LOCATION / DESCRIPTION / NOTE): tiny uppercase label
 *  above wrapping text. Shared with SidebarSearch's contact cards. */
export function DetailField(props: { label: string; text: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">{props.label}</span>
      <span class="whitespace-pre-line break-words text-xs text-fg">{props.text}</span>
    </div>
  )
}

/** Expanded detail card beneath a search/contact row: muted well stacking the
 *  labeled fields, with the explicit open action last (row clicks toggle —
 *  navigation moves here). Shared with SidebarSearch's contact cards. */
export function RowDetail(props: { children: ComponentChildren; openLabel?: string; onOpen?: () => void }) {
  return (
    <div class="mr-1 mb-1 ml-2.5 flex flex-col gap-1.5 rounded bg-surface-2 px-2.5 py-2">
      {props.children}
      {props.openLabel && props.onOpen && (
        <button type="button" class="btn btn-ghost btn-sm self-start" onClick={props.onOpen}>
          {props.openLabel}
        </button>
      )}
    </div>
  )
}

interface EventRowProps {
  when: Date
  allDay: boolean
  title: string
  calName: string
  calColor: string
  hour12: boolean
  /** Opt-in detail payload; present → the row toggles an inline card.
   *  SavedComposite rows omit it and stay flat. */
  detail?: {
    /** Occurrence end (null/undefined → start-only display). */
    end?: Date | null
    location?: string
    description?: string
    /** 'Open in schedule' action (navigates the calendar to the date). */
    onOpen?: () => void
  }
  /** Controlled expansion (MatchResults hoists it so only one row is open). */
  expanded?: boolean
  onToggleExpanded?: () => void
}

/** `Wed, Oct 9 · 14:00 – 15:30`, cross-day `Wed, Oct 9 14:00 – Thu, Oct 10 09:00`,
 *  all-day `Wed, Oct 9` / `Wed, Oct 9 – Fri, Oct 11` (ICS DTEND is exclusive —
 *  the displayed all-day end steps back one day; same convention as the event
 *  detail popover). */
function eventRangeText(start: Date, end: Date | null | undefined, allDay: boolean, hour12: boolean): string {
  const crossDay = end != null && dayKey(end) !== dayKey(start)
  if (allDay) {
    if (crossDay) return `${fmtDate(start, { weekday: true })} – ${fmtDate(addDays(end, -1), { weekday: true })}`
    return fmtDate(start, { weekday: true })
  }
  if (crossDay) {
    return `${fmtDate(start, { weekday: true })} ${fmtTime(start, hour12)} – ${fmtDate(end, { weekday: true })} ${fmtTime(end, hour12)}`
  }
  return end
    ? `${fmtDate(start, { weekday: true })} · ${fmtTime(start, hour12)} – ${fmtTime(end, hour12)}`
    : fmtDate(start, { weekday: true })
}

/** Event row: colored dot · date+time · title · calendar name. The date makes
 *  recurring/cross-day occurrences distinguishable (§30 scoped sidebar search:
 *  schedule results must say WHEN each hit happens). With `detail` the row
 *  click toggles an inline card (range, all-day badge, location, description,
 *  calendar, Open button); Enter/Space toggle like click, Esc collapses. */
export function EventRow(props: EventRowProps) {
  const [selfOpen, setSelfOpen] = useState(false)
  const open = props.detail !== undefined ? (props.expanded ?? selfOpen) : false
  const toggle = (): void => {
    if (props.onToggleExpanded) props.onToggleExpanded()
    else setSelfOpen((v) => !v)
  }
  const line = (
    <>
      <span class="chip-dot shrink-0" style={{ background: props.calColor }} />
      <span class="w-28 shrink-0 text-xs tabular-nums text-muted">
        {props.allDay ? fmtDate(props.when) : `${fmtDate(props.when)} ${fmtTime(props.when, props.hour12)}`}
      </span>
      <span class="truncate text-base text-fg-strong">{props.title}</span>
      {props.calName && <span class="ml-auto truncate pl-2 text-sm text-muted">{props.calName}</span>}
    </>
  )
  if (props.detail === undefined) {
    return <div class="flex h-8 items-center gap-2 rounded px-2.5 hover:bg-surface-2">{line}</div>
  }
  return (
    <div class="flex flex-col">
      <button
        type="button"
        class="flex h-8 w-full items-center gap-2 rounded px-2.5 text-left hover:bg-surface-2"
        title={open ? undefined : 'Click for details'}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation()
            toggle()
          }
        }}
      >
        {line}
      </button>
      {open && (
        <RowDetail openLabel="Open in schedule" onOpen={props.detail.onOpen}>
          <p class="flex flex-wrap items-center gap-1.5 text-xs text-fg tabular-nums">
            {eventRangeText(props.when, props.detail.end, props.allDay, props.hour12)}
            {props.allDay && (
              <span class="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">All-day</span>
            )}
          </p>
          {props.detail.location && <DetailField label="Location" text={props.detail.location} />}
          {props.detail.description && <DetailField label="Description" text={snippet(props.detail.description)} />}
          {props.calName && (
            <p class="flex items-center gap-1.5 text-xs text-muted">
              <span class="chip-dot shrink-0" style={{ background: props.calColor }} aria-hidden="true" />
              {props.calName}
            </p>
          )}
        </RowDetail>
      )}
    </div>
  )
}

interface TodoRowProps {
  item: TodoItem
  onToggle?: (record: TodoRecord) => void
  onTagClick?: (tag: string) => void
  indented?: boolean
  /** Opt-in; present → the row (not the checkbox/tag chips) toggles an
   *  inline detail card. SavedComposite rows omit it and stay flat. */
  detail?: {
    /** 'Open in agenda' action (switches to the agenda mode). */
    onOpen?: () => void
  }
  /** Controlled expansion (MatchResults hoists it so only one row is open). */
  expanded?: boolean
  onToggleExpanded?: () => void
}

/** Task row mirroring TasksView: checkbox, #A/B/C badge, title, tags, due, cal dot.
 *  With `detail` a row click toggles an inline card (full due date, priority
 *  badge, tag chips, note snippet, calendar, Open button); Enter/Space toggle
 *  like click, Esc collapses. Nested controls keep their own clicks/key presses. */
export function TodoRow(props: TodoRowProps) {
  const { item } = props
  const onToggle = props.onToggle ?? toggleDone
  const overdue = item.due !== null && !item.done && item.due.getTime() < startOfToday().getTime()
  const [selfOpen, setSelfOpen] = useState(false)
  const expandable = props.detail !== undefined
  const open = expandable ? (props.expanded ?? selfOpen) : false
  const toggleExpand = (): void => {
    if (props.onToggleExpanded) props.onToggleExpanded()
    else setSelfOpen((v) => !v)
  }
  const head = (
    <>
      {item.prio && <span class={`todo-badge-${item.prio.toLowerCase()}`}>#{item.prio}</span>}
      <span class={item.done ? 'todo-done' : ''}>{item.todo.summary}</span>
      {item.todo.categories.map((tag, i) =>
        props.onTagClick ? (
          <button
            key={`${tag}-${i}`}
            type="button"
            class="tag-chip"
            onClick={(e) => {
              e.stopPropagation()
              props.onTagClick?.(tag)
            }}
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
    </>
  )

  if (!expandable) {
    return (
      <div class="todo-row" style={props.indented ? { paddingLeft: 28 } : undefined}>
        <input
          type="checkbox"
          checked={item.done}
          onChange={() => onToggle(item.record)}
          aria-label={item.done ? `Mark "${item.todo.summary}" not done` : `Mark "${item.todo.summary}" done`}
        />
        {head}
      </div>
    )
  }
  return (
    <div class="flex flex-col">
      <div
        class="todo-row cursor-pointer"
        style={props.indented ? { paddingLeft: 28 } : undefined}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? undefined : 'Click for details'}
        onClick={toggleExpand}
        onKeyDown={(e) => {
          // Enter/Space toggle like click — but only when the row itself has
          // focus; nested checkbox/tag-chip key presses stay their own.
          if (e.key === 'Escape' && open) {
            e.stopPropagation()
            toggleExpand()
          } else if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault()
            toggleExpand()
          }
        }}
      >
        <input
          type="checkbox"
          checked={item.done}
          onChange={() => onToggle(item.record)}
          onClick={(e) => e.stopPropagation()}
          aria-label={item.done ? `Mark "${item.todo.summary}" not done` : `Mark "${item.todo.summary}" done`}
        />
        {head}
      </div>
      {open && props.detail && (
        <RowDetail openLabel="Open in agenda" onOpen={props.detail.onOpen}>
          {(item.due || item.prio) && (
            <p class="flex flex-wrap items-center gap-1.5 text-xs">
              {item.due && (
                <span class={`tabular-nums ${overdue ? 'text-danger' : 'text-fg'}`}>
                  {item.allDay
                    ? fmtDate(item.due, { weekday: true, year: true })
                    : `${fmtDate(item.due, { weekday: true, year: true })} · ${fmtTime(item.due, prefs.value.hour12)}`}
                </span>
              )}
              {item.prio && <span class={`todo-badge-${item.prio.toLowerCase()}`}>#{item.prio}</span>}
            </p>
          )}
          {item.todo.categories.length > 0 && (
            <div class="flex flex-wrap gap-1">
              {item.todo.categories.map((tag, i) => (
                <span key={`${tag}-${i}`} class="tag-chip">
                  {tag}
                </span>
              ))}
            </div>
          )}
          {item.todo.description && <DetailField label="Note" text={snippet(item.todo.description)} />}
          {item.calName && (
            <p class="flex items-center gap-1.5 text-xs text-muted">
              <span class="chip-dot shrink-0" style={{ background: item.calColor }} aria-hidden="true" />
              {item.calName}
            </p>
          )}
        </RowDetail>
      )}
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
 *  `only` renders a single group (sidebar search stacks Contacts between).
 *  `expandable` opts rows into inline detail cards — one open at a time
 *  (second click or Esc collapses, opening a row collapses its siblings);
 *  `onOpen` backs the cards' Open buttons. SavedComposite passes neither and
 *  gets the flat rows. */
export function MatchResults(props: {
  items: MatchItem[]
  onTagClick?: (tag: string) => void
  only?: 'events' | 'todos'
  expandable?: boolean
  onOpen?: (item: MatchItem) => void
}) {
  const hour12 = prefs.value.hour12
  const [openKey, setOpenKey] = useState<string | null>(null)
  const showEvents = props.only !== 'todos'
  const showTodos = props.only !== 'events'
  const events = groupByDay(props.items.filter((i): i is EventItem => i.kind === 'event'))
  const tasks = groupByDay(props.items.filter((i): i is TodoItem => i.kind === 'todo'))

  /** Controlled-expansion extras for one row over the shared open key
   *  (kind-prefixed: event and todo record keys share one namespace). */
  const eventExtras = (it: EventItem) =>
    props.expandable
      ? {
          detail: {
            end: it.ev.end ? icsDateToDate(it.ev.end) : null,
            location: it.ev.location,
            description: it.ev.description,
            onOpen: props.onOpen ? () => props.onOpen?.(it) : undefined,
          },
          expanded: openKey === `event:${it.record.key}`,
          onToggleExpanded: () =>
            setOpenKey((k) => (k === `event:${it.record.key}` ? null : `event:${it.record.key}`)),
        }
      : {}
  const todoExtras = (it: TodoItem) =>
    props.expandable
      ? {
          detail: { onOpen: props.onOpen ? () => props.onOpen?.(it) : undefined },
          expanded: openKey === `todo:${it.record.key}`,
          onToggleExpanded: () =>
            setOpenKey((k) => (k === `todo:${it.record.key}` ? null : `todo:${it.record.key}`)),
        }
      : {}

  return (
    <div
      class="flex flex-col"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && openKey !== null) {
          e.stopPropagation()
          setOpenKey(null)
        }
      }}
    >
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
                  {...eventExtras(it)}
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
                <TodoRow key={it.record.key} item={it} onTagClick={props.onTagClick} {...todoExtras(it)} />
              ))}
            </div>
          ))}
          {tasks.undated.length > 0 && (
            <div>
              <DayHeading label="No due date" />
              {tasks.undated.map((it) => (
                <TodoRow key={it.record.key} item={it} onTagClick={props.onTagClick} {...todoExtras(it)} />
              ))}
            </div>
          )}
          {tasks.groups.length === 0 && tasks.undated.length === 0 && <p class="text-sm text-muted">No matching tasks.</p>}
        </>
      )}
    </div>
  )
}

