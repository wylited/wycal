/**
 * Search/match engine (CONTRACTS §15) — pure tokenizer + matchers over the
 * events/todos stores. Row renderers and the view live in SearchMatchView.tsx.
 *
 * Query grammar — whitespace-separated tokens, ALL must match (AND):
 *   tag:x           categories include tag `x` (exact, case-insensitive)
 *   cal:x           calendar name contains `x` (case-insensitive)
 *   prio:A|B|C      tasks only — priority letter (1–3 / 4–6 / 7–9)
 *   due:Nd          relevant date within the next N days (events: start,
 *                   tasks: due date)
 *   done:true|false tasks only — STATUS COMPLETED or not
 *   /regex/         case-insensitive regex over summary + description +
 *                   categories (invalid → inline error, never a crash)
 *   anything else   free text over summary + location + description +
 *                   categories
 *
 * Events are evaluated as occurrences over a wide window (30 days back →
 * 180 days ahead) via the store's memoized expansion; tasks are window-free.
 */
import { addDays } from '../lib/util/date'
import { computed } from '@preact/signals-core'
import { icsDateToDate, prioLetter } from '../lib/ics/types'
import type { IcsEvent, IcsTodo } from '../lib/ics/types'
import { collectionColor, collections, visibleCalendars } from '../stores/calendars'
import { occurrences } from '../stores/events'
import type { EventRecord } from '../stores/events'
import { todos } from '../stores/todos'
import type { TodoRecord } from '../stores/todos'

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type SearchToken =
  | { kind: 'tag'; value: string }
  | { kind: 'cal'; value: string }
  | { kind: 'prio'; letter: 'A' | 'B' | 'C' }
  | { kind: 'due'; days: number }
  | { kind: 'done'; value: boolean }
  | { kind: 'regex'; body: string }
  | { kind: 'text'; value: string }

const KEYWORD_RE = /^(tag|cal|prio|due|done):(.*)$/

/** Split a query into tokens; invalid `/regex/` → `error` (results withheld). */
export function tokenizeQuery(query: string): { tokens: SearchToken[]; error: string | null } {
  const tokens: SearchToken[] = []
  let i = 0
  while (i < query.length) {
    const ch = query[i]
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    if (ch === '/') {
      // A regex token may contain spaces; scan to the closing slash.
      const close = query.indexOf('/', i + 1)
      if (close === -1) return { tokens, error: 'Unterminated regex — close it with a trailing /' }
      const body = query.slice(i + 1, close)
      i = close + 1
      if (body.length === 0) return { tokens, error: 'Empty regex between the slashes' }
      try {
        new RegExp(body, 'i')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { tokens, error: `Invalid regex /${body}/ — ${msg}` }
      }
      tokens.push({ kind: 'regex', body })
      continue
    }
    let j = i
    while (j < query.length && query[j] !== ' ' && query[j] !== '\t') j += 1
    const raw = query.slice(i, j)
    i = j
    const kw = KEYWORD_RE.exec(raw)
    if (kw) {
      const kind = kw[1].toLowerCase()
      const value = kw[2]
      if (kind === 'tag' && value) tokens.push({ kind: 'tag', value })
      else if (kind === 'cal' && value) tokens.push({ kind: 'cal', value })
      else if (kind === 'prio' && /^[abc]$/i.test(value)) tokens.push({ kind: 'prio', letter: value.toUpperCase() as 'A' | 'B' | 'C' })
      else if (kind === 'due' && /^\d+d$/i.test(value)) tokens.push({ kind: 'due', days: parseInt(value, 10) })
      else if (kind === 'done' && /^(true|false)$/i.test(value)) tokens.push({ kind: 'done', value: value.toLowerCase() === 'true' })
      else tokens.push({ kind: 'text', value: raw })
    } else {
      tokens.push({ kind: 'text', value: raw })
    }
  }
  return { tokens, error: null }
}

/** Token back to its canonical source form (for query rewrites). */
export function tokenToText(t: SearchToken): string {
  switch (t.kind) {
    case 'tag': return `tag:${t.value}`
    case 'cal': return `cal:${t.value}`
    case 'prio': return `prio:${t.letter}`
    case 'due': return `due:${t.days}d`
    case 'done': return `done:${t.value}`
    case 'regex': return `/${t.body}/`
    case 'text': return t.value
  }
}

// ---------------------------------------------------------------------------
// Match items
// ---------------------------------------------------------------------------

export interface EventItem {
  kind: 'event'
  record: EventRecord
  ev: IcsEvent
  /** Occurrence start (grouping + due:Nd reference). */
  when: Date
  due: null
  allDay: boolean
  calUrl: string
  calName: string
  calColor: string
  categories: string[]
  haystack: string
  /** Regex-token haystack: summary + description + categories (no location). */
  regexHaystack: string
  done: false
  prio: null
}

export interface TodoItem {
  kind: 'todo'
  record: TodoRecord
  todo: IcsTodo
  /** Due, else dtstart; null when neither (grouped under "No due date"). */
  when: Date | null
  due: Date | null
  allDay: boolean
  calUrl: string
  calName: string
  calColor: string
  categories: string[]
  haystack: string
  /** Regex-token haystack: summary + description + categories (no location). */
  regexHaystack: string
  done: boolean
  prio: 'A' | 'B' | 'C' | null
}

export type MatchItem = EventItem | TodoItem

const MATCH_WINDOW_PAST_DAYS = 30
const MATCH_WINDOW_FUTURE_DAYS = 180

export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function collectionMaps() {
  const cols = new Map(collections.value.map((c) => [c.url, c]))
  const info = (url: string) => {
    const col = cols.get(url)
    return { name: col?.name ?? '', color: col ? collectionColor(col) : 'var(--muted)' }
  }
  return info
}

/** Todo match items across visible calendars (no time window). */
export function collectTodoItems(): TodoItem[] {
  const info = collectionMaps()
  const items: TodoItem[] = []
  for (const record of todos.value.values()) {
    if (!visibleCalendars.value.has(record.calendarUrl)) continue
    const data = record.data
    const { name, color } = info(record.calendarUrl)
    const due = data.due ? icsDateToDate(data.due) : null
    const dtstart = data.dtstart ? icsDateToDate(data.dtstart) : null
    items.push({
      kind: 'todo',
      record,
      todo: data,
      when: due ?? dtstart,
      due,
      allDay: (data.due?.date ?? data.dtstart?.date) != null,
      calUrl: record.calendarUrl,
      calName: name,
      calColor: color,
      categories: data.categories,
      haystack: [data.summary, data.description ?? '', ...data.categories].join('\n').toLowerCase(),
      regexHaystack: [data.summary, data.description ?? '', ...data.categories].join('\n').toLowerCase(),
      done: data.status === 'COMPLETED',
      prio: prioLetter(data.priority),
    })
  }
  return items
}

/** Event occurrences (wide window) + all todo items — the search universe. */
export function collectMatchItems(): MatchItem[] {
  const info = collectionMaps()
  const items: MatchItem[] = []
  const start = addDays(startOfToday(), -MATCH_WINDOW_PAST_DAYS)
  const end = addDays(startOfToday(), MATCH_WINDOW_FUTURE_DAYS + 1)
  for (const record of occurrences({ start: start.toISOString(), end: end.toISOString() })) {
    const data = record.data
    const { name, color } = info(record.calendarUrl)
    items.push({
      kind: 'event',
      record,
      ev: data,
      when: icsDateToDate(data.start),
      due: null,
      allDay: data.allDay,
      calUrl: record.calendarUrl,
      calName: name,
      calColor: color,
      categories: data.categories,
      haystack: [data.summary, data.location ?? '', data.description ?? '', ...data.categories].join('\n').toLowerCase(),
      regexHaystack: [data.summary, data.description ?? '', ...data.categories].join('\n').toLowerCase(),
      done: false,
      prio: null,
    })
  }
  items.push(...collectTodoItems())
  return items
}

/**
 * The search universe as a signal `computed`: rebuilds only when the
 * underlying store signals change (occurrence revision + calendar
 * visibility via `occurrences`, the todos store, collections) — NOT on every
 * keystroke in the search view. Views tokenize + filter per render against
 * `matchUniverse.value` (filtering is cheap; collection is not).
 */
export const matchUniverse = computed(() => collectMatchItems())

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function tokenMatches(item: MatchItem, token: SearchToken, regex: RegExp | null, today: Date): boolean {
  switch (token.kind) {
    case 'tag': {
      const want = token.value.toLowerCase()
      return item.categories.some((c) => c.toLowerCase() === want)
    }
    case 'cal':
      return item.calName.toLowerCase().includes(token.value.toLowerCase())
    case 'prio':
      return item.kind === 'todo' && item.prio === token.letter
    case 'done':
      return item.kind === 'todo' && item.done === token.value
    case 'due': {
      const when = item.kind === 'todo' ? item.due : item.when
      if (!when) return false
      const t = when.getTime()
      return t >= today.getTime() && t < addDays(today, token.days + 1).getTime()
    }
    case 'regex':
      return regex !== null && regex.test(item.regexHaystack)
    case 'text':
      return item.haystack.includes(token.value.toLowerCase())
  }
}

/** AND of all tokens; regexes re-validated defensively (bad → never matches). */
export function filterMatchItems(items: MatchItem[], tokens: SearchToken[]): MatchItem[] {
  const today = startOfToday()
  const regexes = tokens.map((t) => {
    if (t.kind !== 'regex') return null
    try {
      return new RegExp(t.body, 'i')
    } catch {
      return null
    }
  })
  const out: MatchItem[] = []
  outer: for (const item of items) {
    for (let k = 0; k < tokens.length; k++) {
      if (!tokenMatches(item, tokens[k], regexes[k], today)) continue outer
    }
    out.push(item)
  }
  return out
}
