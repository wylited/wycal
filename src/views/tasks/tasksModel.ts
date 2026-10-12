/**
 * Pure tasks-view model (CONTRACTS §15, design.md §9.4): quick-add org-syntax
 * parser, sort comparators, group builders, and the parent/child row tree.
 * No Preact here — the view (TasksView.tsx) renders what these return.
 */
import type { IcsDate } from '../../lib/ics/types'
import { icsDateToDate, localDateStr, localMidnight, toIcsDateInput } from '../../lib/ics/types'
import type { TodoRecord } from '../../stores/todos'
import { collectionColor, collections } from '../../stores/calendars'

export type StatusFilter = 'all' | 'open' | 'done' | 'stuck'
export type GroupBy = 'calendar' | 'tag' | 'priority' | 'none'
export type SortBy = 'priority' | 'due' | 'created'

// ---------------------------------------------------------------------------
// Quick-add org syntax (CONTRACTS §15)
// ---------------------------------------------------------------------------

/** One parsed quick-add line: summary plus extracted tokens. */
interface ParsedQuickAdd {
  summary: string
  categories: string[]
  priority?: 1 | 4 | 7
  due?: IcsDate
}

const PRIORITY_TOKEN = /^#([abc])$/i
const ABS_DUE_TOKEN = /^d:(\d{4}-\d{2}-\d{2})$/i
const REL_DUE_TOKEN = /^d:\+(\d+)([dwm])$/i

/** +1w = 7 days, +1m = 30 days (contract wording); +Nd is literal. */
function relDueDays(count: number, unit: 'd' | 'w' | 'm'): number {
  if (unit === 'w') return count * 7
  if (unit === 'm') return count * 30
  return count
}

/**
 * Split a quick-add line: `:t1:t2:` tokens → categories, `#A|#B|#C` →
 * priority 1|4|7, `d:YYYY-MM-DD` or `d:+Nd|+Nw|+Nm` → all-day due; the
 * remainder joins the summary. Plain text only → the whole line is the
 * summary; an impossible calendar date (2026-02-31) is consumed but ignored.
 */
export function parseQuickAdd(input: string): ParsedQuickAdd {
  const categories: string[] = []
  let priority: ParsedQuickAdd['priority']
  let due: IcsDate | undefined
  const words: string[] = []
  for (const token of input.split(/\s+/)) {
    if (!token) continue
    const prio = PRIORITY_TOKEN.exec(token)
    if (prio) {
      const letter = prio[1].toLowerCase()
      priority = letter === 'a' ? 1 : letter === 'b' ? 4 : 7
      continue
    }
    const abs = ABS_DUE_TOKEN.exec(token)
    if (abs) {
      const ds = abs[1]
      // localMidnight('2026-02-31') rolls over to March — reject such input.
      if (localDateStr(localMidnight(ds)) === ds) due = toIcsDateInput(localMidnight(ds), true)
      continue
    }
    const rel = REL_DUE_TOKEN.exec(token)
    if (rel) {
      const now = new Date()
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const unit = rel[2].toLowerCase() as 'd' | 'w' | 'm'
      target.setDate(target.getDate() + relDueDays(Number(rel[1]), unit))
      // A huge +N rolls past the valid Date range → treat as plain text.
      if (!Number.isFinite(target.getTime())) {
        words.push(token)
        continue
      }
      due = toIcsDateInput(localMidnight(localDateStr(target)), true)
      continue
    }
    if (token.length > 2 && token.startsWith(':') && token.endsWith(':')) {
      for (const tag of token.slice(1, -1).split(':')) if (tag) categories.push(tag)
      continue
    }
    words.push(token)
  }
  return { summary: words.join(' '), categories, priority, due }
}

// ---------------------------------------------------------------------------
// Filter → group → sort → tree
// ---------------------------------------------------------------------------

/** Priority band rank: A(1–3)→1, B(4–6)→2, C(7–9)→3, none→4. */
function prioRank(priority: number | undefined): number {
  if (priority == null) return 4
  if (priority <= 3) return 1
  if (priority <= 6) return 2
  return 3
}

/** Agenda placement instant of a todo: its due, else null. */
export function dueTime(rec: TodoRecord): number | null {
  return rec.data.due ? icsDateToDate(rec.data.due).getTime() : null
}

const UNDATED = Number.MAX_SAFE_INTEGER

type Compare = (a: TodoRecord, b: TodoRecord) => number

/**
 * Row ordering. Priority: #A < #B < #C < none, then due. Due: ascending,
 * undated last, then priority. Created: store insertion order (Map order).
 */
export function makeCompare(sortBy: SortBy, createdIndex: Map<string, number>): Compare {
  const byCreated: Compare = (a, b) =>
    (createdIndex.get(a.key) ?? 0) - (createdIndex.get(b.key) ?? 0)
  const byDue: Compare = (a, b) => {
    const da = dueTime(a) ?? UNDATED
    const db = dueTime(b) ?? UNDATED
    return da !== db ? da - db : byCreated(a, b)
  }
  if (sortBy === 'created') return byCreated
  if (sortBy === 'due') return byDue
  return (a, b) => {
    const pa = prioRank(a.data.priority)
    const pb = prioRank(b.data.priority)
    return pa !== pb ? pa - pb : byDue(a, b)
  }
}

interface TaskGroup {
  id: string
  header?: { label: string; color?: string }
  recs: TodoRecord[]
}

/** Group members per §15; each group's rows keep the active sort order. */
export function buildGroups(groupBy: GroupBy, recs: TodoRecord[], compare: Compare): TaskGroup[] {
  const sorted = [...recs].sort(compare)
  if (groupBy === 'none') return [{ id: 'all', recs: sorted }]
  if (groupBy === 'calendar') {
    const groups: TaskGroup[] = []
    for (const cal of collections.value) {
      if (cal.kind !== 'calendar') continue
      const inCal = sorted.filter((r) => r.calendarUrl === cal.url)
      if (inCal.length === 0) continue
      groups.push({ id: cal.url, header: { label: cal.name || cal.url, color: collectionColor(cal) }, recs: inCal })
    }
    // Todos whose calendar vanished from the store stay visible under 'Other'.
    const known = new Set(groups.map((g) => g.id))
    const rest = sorted.filter((r) => !known.has(r.calendarUrl))
    if (rest.length > 0) groups.push({ id: 'other', header: { label: 'Other' }, recs: rest })
    return groups
  }
  if (groupBy === 'priority') {
    const defs = [
      { id: 'a', label: '#A', rank: 1 },
      { id: 'b', label: '#B', rank: 2 },
      { id: 'c', label: '#C', rank: 3 },
      { id: 'none', label: 'No priority', rank: 4 },
    ]
    return defs
      .map((d) => ({ id: d.id, header: { label: d.label }, recs: sorted.filter((r) => prioRank(r.data.priority) === d.rank) }))
      .filter((g) => g.recs.length > 0)
  }
  // Tag grouping: a todo with several tags appears under each; none → 'No tags'.
  const byTag = new Map<string, TodoRecord[]>()
  const untagged: TodoRecord[] = []
  for (const rec of sorted) {
    if (rec.data.categories.length === 0) {
      untagged.push(rec)
      continue
    }
    for (const tag of rec.data.categories) {
      const list = byTag.get(tag)
      if (list) list.push(rec)
      else byTag.set(tag, [rec])
    }
  }
  const groups: TaskGroup[] = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, list]) => ({ id: `tag:${tag}`, header: { label: tag }, recs: list }))
  if (untagged.length > 0) groups.push({ id: 'tag:none', header: { label: 'No tags' }, recs: untagged })
  return groups
}

interface TaskRowSpec {
  rec: TodoRecord
  depth: 0 | 1
}

/**
 * Fold children one level under their parent (CONTRACTS §15): a member whose
 * parent is in the same group renders indented beneath it; orphans (parent
 * filtered out, in another group/calendar, or missing) stay top-level.
 */
export function treeRows(
  members: TodoRecord[],
  byUid: Map<string, TodoRecord>,
  compare: Compare,
  childrenOf: (parentUid: string) => TodoRecord[],
): TaskRowSpec[] {
  const inGroup = new Set(members.map((r) => r.key))
  const asChild = new Set<string>()
  for (const m of members) {
    if (!m.data.relatedTo) continue
    const parent = byUid.get(m.data.relatedTo)
    if (parent && parent.key !== m.key && inGroup.has(parent.key)) asChild.add(m.key)
  }
  const rows: TaskRowSpec[] = []
  for (const m of members) {
    if (asChild.has(m.key)) continue
    rows.push({ rec: m, depth: 0 })
    for (const child of [...childrenOf(m.data.uid)].sort(compare)) {
      if (child.key !== m.key && inGroup.has(child.key)) rows.push({ rec: child, depth: 1 })
    }
  }
  return rows
}
