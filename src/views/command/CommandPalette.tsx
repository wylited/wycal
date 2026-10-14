/** @jsxImportSource preact */
/**
 * ⌘K command palette (wave 14, Raycast-style): one fixed centered overlay —
 * big NL input on top, results pane below, detail preview card on the right.
 * Typing runs command/nl `interpret()` live: the top result is the CREATE
 * action ('New event · lunch with ivy · tomorrow 12:30 · 45m · cafe' with the
 * parsed chips highlighted); below it, search results from searchEngine
 * `matchUniverse` (events/todos, day-grouped like MatchResults) plus contacts
 * (SidebarSearch's plain-text contact matching pattern). ↑/↓ move the
 * selection, Enter executes, Tab/Shift+Tab cycle the create kind
 * (event↔task↔contact, forward/back), Esc closes and restores focus, hover
 * selects. Creating routes through the existing dialogs: events/tasks via
 * `openQuickAddFields(...)` — the parsed Interpretation handed over as
 * structured fields so the dialog never re-parses (the base grammar would
 * drop the recurrence/location overlays) — contacts via the
 * `pendingContactPrefill` signal (set before navigating; ContactsView
 * consumes it on mount) plus the `wycal:newcontact` window event carrying
 * `detail.prefill {fn, email, tel}` for the already-mounted case. Empty input
 * shows quick actions; a non-empty query always shows the create row.
 *
 * Mounted once by app.tsx next to QuickAddDialog; ⌘K/Ctrl+K toggles, '/'
 * opens (the palette is a superset of the old sidebar-search focus). Open
 * state is a module-level signal (todoEditor.ts pattern), so any callsite
 * can open it without wiring.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { signal } from '@preact/signals'
import { contacts, requestOpenContact } from '../../stores/contacts'
import { prefs, setPrefs } from '../../stores/prefs'
import { bumpDialogClose, bumpDialogOpen, requestNewEvent } from '../../stores/ui'
import { icsDateToDate, prioLetter } from '../../lib/ics/types'
import { dayKey, fmtDate, fmtTime } from '../../lib/util/date'
import { gotoCalendarQuery, ROUTES } from '../../routes'
import { Icon } from '../../ui/icons'
import { pendingContactPrefill } from '../contacts/prefill'
import { openQuickAdd, openQuickAddFields } from '../quickadd/QuickAddDialog'
import { filterMatchItems, matchUniverse, tokenizeQuery } from '../search/searchEngine'
import type { EventItem, TodoItem } from '../search/searchEngine'
import { interpret } from './nl'
import type { Chip, Interpretation } from './nl'

// ---------------------------------------------------------------------------
// Open/close plumbing (todoEditor.ts / QuickAddDialog signal pattern)
// ---------------------------------------------------------------------------

interface PaletteRequest {
  /** Monotonic counter: re-opens remount the card (fresh state + autofocus). */
  seq: number
}

const request = signal<PaletteRequest | null>(null)
let seqCounter = 0
let lastFocused: HTMLElement | null = null

export function isCommandPaletteOpen(): boolean {
  return request.value !== null
}

export function openCommandPalette(): void {
  if (request.value === null) lastFocused = document.activeElement as HTMLElement | null
  request.value = { seq: ++seqCounter }
}

export function closeCommandPalette(): void {
  if (request.value === null) return
  request.value = null
  lastFocused?.focus()
  lastFocused = null
}

/** Mounted once by app.tsx; renders the palette from the `request` signal. */
export function CommandPalette() {
  const open = request.value !== null
  // Register as an open dialog (stores/ui) so the global keybinds gate while up.
  useEffect(() => {
    if (!open) return
    bumpDialogOpen()
    return bumpDialogClose
  }, [open])
  const req = request.value
  if (req === null) return null
  return <PaletteCard key={req.seq} />
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** 'New contact' path: stamp the structured prefill (ContactsView consumes it
 *  on mount, so the route change can't race it away), navigate, then raise
 *  wycal:newcontact — now + next macrotask (pingRouteView pattern) for the
 *  already-mounted case. detail.prefill carries the NL candidate {fn, email,
 *  tel}; the no-candidate action passes a blank fn. */
function createContact(prefill?: { fn: string; email?: string; tel?: string }): void {
  pendingContactPrefill.value = prefill ?? { fn: '' }
  if (window.location.hash !== `#${ROUTES.contacts}`) window.location.hash = ROUTES.contacts
  const fire = (): void => {
    window.dispatchEvent(new CustomEvent('wycal:newcontact', { detail: { prefill } }))
  }
  fire()
  window.setTimeout(fire, 0)
}

const THEMES = ['light', 'dark', 'auto'] as const

function toggleTheme(): void {
  const next = THEMES[(THEMES.indexOf(prefs.value.theme) + 1) % THEMES.length]
  setPrefs({ theme: next })
}

const BYDAY_FULL: Record<string, string> = {
  MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun',
}

const FREQ_WORD: Record<string, string> = {
  DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year',
}

/** 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' → 'Every 2 weeks on Mon, Wed'. */
function describeRrule(rrule: string): string {
  const parts = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1))
  }
  const freq = parts.get('FREQ') ?? ''
  const noun = FREQ_WORD[freq] ?? freq.toLowerCase()
  const interval = Number(parts.get('INTERVAL') ?? '1')
  const bits = interval > 1 ? `Every ${interval} ${noun}s` : noun === 'day' ? 'Every day' : `Every ${noun}`
  const byday = parts.get('BYDAY')
  if (byday === 'MO,TU,WE,TH,FR') return `${bits} on weekdays`
  if (byday !== undefined) {
    return `${bits} on ${byday.split(',').map((d) => BYDAY_FULL[d] ?? d).join(', ')}`
  }
  return bits
}

/** 'Fri Oct 16 · 5:00pm' (time dropped when all-day). */
function fmtWhen(d: Date, allDay: boolean): string {
  const date = fmtDate(d, { weekday: true })
  return allDay ? date : `${date} · ${fmtTime(d, prefs.value.hour12)}`
}

/** Same-day → 'Fri Oct 16 · 12:30pm–1:15pm'; cross-day → both ends. */
function fmtRange(start: Date, end: Date, allDay: boolean): string {
  if (allDay) return fmtDate(start, { weekday: true })
  if (dayKey(start) === dayKey(end)) {
    return `${fmtDate(start, { weekday: true })} · ${fmtTime(start, prefs.value.hour12)}–${fmtTime(end, prefs.value.hour12)}`
  }
  return `${fmtWhen(start, false)} – ${fmtWhen(end, false)}`
}

/** 45 → '45m', 90 → '1h 30m'. */
function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Wrap the first occurrence of each query token in the title with <mark>
 *  (case-insensitive substring; overlaps keep the earlier hit). */
function highlight(title: string, tokens: string[]): string | (string | JSX.Element)[] {
  if (title === '' || tokens.length === 0) return title
  const lower = title.toLowerCase()
  const ranges: [number, number][] = []
  for (const t of tokens) {
    const at = lower.indexOf(t.toLowerCase())
    if (at >= 0) ranges.push([at, at + t.length])
  }
  if (ranges.length === 0) return title
  ranges.sort((a, b) => a[0] - b[0])
  const out: (string | JSX.Element)[] = []
  let pos = 0
  for (const [start, end] of ranges) {
    if (start < pos) continue
    if (start > pos) out.push(title.slice(pos, start))
    out.push(
      <mark key={start} class="bg-transparent text-accent font-semibold">
        {title.slice(start, end)}
      </mark>,
    )
    pos = end
  }
  if (pos < title.length) out.push(title.slice(pos))
  return out
}

/** Parsed-chip tint per kind — theme.css §27 component classes: light-mode
 *  bright tokens read ~2:1 on soft fills, so 12px AA text needs the -ink
 *  tokens (dark mode resolves them back to the bright tokens). */
const CHIP_CLASS: Record<Chip['kind'], string> = {
  date: 'wycal-pchip-accent',
  time: 'wycal-pchip-accent',
  duration: 'wycal-pchip-neutral',
  priority: 'wycal-pchip-danger',
  tag: 'wycal-pchip-neutral',
  recurrence: 'wycal-pchip-accent',
  location: 'wycal-pchip-warning',
  'contact-name': 'wycal-pchip-accent',
  'contact-info': 'wycal-pchip-neutral',
}

/** Merge adjacent date+time chips so 'tomorrow 12:30' reads as one fragment. */
function mergeChips(chips: Chip[]): Chip[] {
  const out: Chip[] = []
  for (const c of chips) {
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.kind === 'date' && c.kind === 'time' && c.start <= prev.end + 1) {
      out[out.length - 1] = { ...prev, end: c.end, text: `${prev.text.trim()} ${c.text.trim()}` }
      continue
    }
    out.push(c)
  }
  return out
}

interface ContactHit {
  href: string
  fn: string
  detail: string
  org?: string
}

/** Text tokens of a query for the contacts pass (contacts ignore the keyword grammar). */
function contactTokens(query: string): string[] {
  const { tokens, error } = tokenizeQuery(query)
  if (error) return []
  const out: string[] = []
  for (const t of tokens) {
    if (t.kind === 'text') out.push(t.value.toLowerCase())
  }
  return out
}

/** SidebarSearch's contact matcher: every token must appear in the card's text. */
function matchContacts(
  data: {
    fn: string
    org?: string
    title?: string
    note?: string
    emails: { value: string }[]
    tels: { value: string }[]
  },
  tokens: string[],
): boolean {
  if (tokens.length === 0) return false
  const hay = [
    data.fn,
    data.org ?? '',
    data.title ?? '',
    data.note ?? '',
    ...data.emails.map((e) => e.value),
    ...data.tels.map((t) => t.value),
  ]
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => hay.includes(t))
}

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

type Entry =
  | { type: 'create' }
  | {
      type: 'action'
      id: string
      label: string
      hint: string
      icon: 'plus' | 'calendar' | 'users' | 'sunMoon'
      run: () => void
    }
  | { type: 'event'; item: EventItem }
  | { type: 'todo'; item: TodoItem }
  | { type: 'contact'; href: string; fn: string; detail: string; org?: string }

/** One render row: the entry, its flat selection index, any headings above. */
interface Row {
  entry: Entry
  idx: number
  heading?: { text: string; level: 'section' | 'day' }[]
}

interface DayGroup<T> {
  key: string
  label: string
  items: T[]
}

/** Sort by `when` and group by local day (MatchResults ordering). */
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

/** Per-kind result cap — the pane scrolls, but a wall of 'e' hits helps nobody. */
const MAX_PER_KIND = 12

const ACTIONS: Entry[] = [
  { type: 'action', id: 'new-event', label: 'New event', hint: 'N', icon: 'plus', run: requestNewEvent },
  { type: 'action', id: 'new-task', label: 'New task', hint: '⇧N', icon: 'plus', run: () => openQuickAdd('todo') },
  { type: 'action', id: 'new-contact', label: 'New contact', hint: 'C', icon: 'users', run: () => createContact() },
  {
    type: 'action', id: 'go-schedule', label: 'Go to Schedule', hint: '', icon: 'calendar',
    run: () => { window.location.hash = ROUTES.calendar },
  },
  {
    type: 'action', id: 'go-agenda', label: 'Go to Agenda', hint: '', icon: 'calendar',
    run: () => gotoCalendarQuery({ view: 'agenda' }),
  },
  {
    type: 'action', id: 'go-contacts', label: 'Go to Contacts', hint: '', icon: 'users',
    run: () => { window.location.hash = ROUTES.contacts },
  },
  { type: 'action', id: 'toggle-theme', label: 'Toggle theme', hint: '', icon: 'sunMoon', run: toggleTheme },
]

const CREATE_KINDS = ['event', 'todo', 'contact'] as const
type CreateKind = (typeof CREATE_KINDS)[number]

const CREATE_LABEL: Record<CreateKind, string> = { event: 'New event', todo: 'New task', contact: 'New contact' }

// ---------------------------------------------------------------------------
// The palette card
// ---------------------------------------------------------------------------

function PaletteCard() {
  const [draft, setDraft] = useState('')
  const [kindOverride, setKindOverride] = useState<CreateKind | null>(null)
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Document-level Escape: the global `q` key synthesizes a plain Escape on
  // `document` (never through the input's own keydown), so catch it like
  // Modal/EventEditor do.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeCommandPalette()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [])

  const trimmed = draft.trim()
  const interp = useMemo(() => interpret(draft), [draft])
  const createKind: CreateKind = kindOverride ?? interp.kind

  // New keystroke: the parse owns the kind again, selection back to the top.
  useEffect(() => {
    setKindOverride(null)
    setIdx(0)
  }, [draft])

  // Search the stripped title — 'lunch with ivy tomorrow 12:30 …' should find
  // 'lunch with ivy', not AND-match every NL token. Falls back to the raw
  // line when nothing parsed away.
  const query = interp.title !== '' ? interp.title : trimmed
  const { tokens, error } = useMemo(() => tokenizeQuery(query), [query])
  const matches = useMemo(
    () => (error !== null || query === '' ? [] : filterMatchItems(matchUniverse.value, tokens)),
    [query, error, tokens],
  )
  /** Text tokens only, for row-title <mark> highlighting. */
  const hlTokens = useMemo(() => tokens.filter((t) => t.kind === 'text').map((t) => t.value), [tokens])
  const hits: ContactHit[] = useMemo(() => {
    const q = contactTokens(query)
    if (error !== null || q.length === 0) return []
    const out: ContactHit[] = []
    const seen = new Set<string>()
    for (const rec of contacts.value.values()) {
      if (seen.has(rec.href) || !matchContacts(rec.data, q)) continue
      seen.add(rec.href)
      out.push({
        href: rec.href,
        fn: rec.data.fn,
        detail: rec.data.emails[0]?.value ?? rec.data.tels[0]?.value ?? rec.data.org ?? rec.data.title ?? '',
        org: rec.data.org,
      })
      if (out.length >= 20) break
    }
    return out
  }, [query, error])

  const { rows, count } = useMemo(() => {
    const out: Row[] = []
    const push = (entry: Entry, heading?: Row['heading']): void => {
      out.push({ entry, idx: out.length, heading })
    }
    if (trimmed === '') {
      for (let i = 0; i < ACTIONS.length; i++) {
        push(ACTIONS[i], i === 0 ? [{ text: 'Actions', level: 'section' }] : undefined)
      }
      return { rows: out, count: out.length }
    }
    // The create row is ALWAYS first for a non-empty query — bare tokens that
    // leave no title ('3pm', 'tomorrow', 'every day') still create something.
    push({ type: 'create' })

    // Events and tasks, each day-grouped like MatchResults; the section
    // heading rides the group's first row, the day heading every row's group
    // head. Per-kind cap keeps the pane scannable.
    const events = groupByDay(matches.filter((i): i is EventItem => i.kind === 'event'))
    const todos = groupByDay(matches.filter((i): i is TodoItem => i.kind === 'todo'))
    let eventBudget = MAX_PER_KIND
    let eventsHeaded = false
    for (const g of [...events.groups, { key: 'undated', label: 'No date', items: events.undated }]) {
      for (const it of g.items) {
        if (eventBudget <= 0) break
        const heading: Row['heading'] = []
        if (!eventsHeaded) heading.push({ text: 'Events', level: 'section' })
        heading.push({ text: g.label, level: 'day' })
        push({ type: 'event', item: it }, heading)
        eventsHeaded = true
        eventBudget -= 1
      }
    }
    let todoBudget = MAX_PER_KIND
    let todosHeaded = false
    for (const g of [...todos.groups, { key: 'undated', label: 'No due date', items: todos.undated }]) {
      for (const it of g.items) {
        if (todoBudget <= 0) break
        const heading: Row['heading'] = []
        if (!todosHeaded) heading.push({ text: 'Tasks', level: 'section' })
        heading.push({ text: g.label, level: 'day' })
        push({ type: 'todo', item: it }, heading)
        todosHeaded = true
        todoBudget -= 1
      }
    }
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]
      push({ type: 'contact', href: h.href, fn: h.fn, detail: h.detail }, i === 0 ? [{ text: 'Contacts', level: 'section' }] : undefined)
    }
    return { rows: out, count: out.length }
  }, [trimmed, interp, matches, hits])

  const sel = Math.min(idx, Math.max(0, count - 1))
  const selRow = rows.find((r) => r.idx === sel)

  useEffect(() => {
    paneRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function runEntry(row: Row | undefined): void {
    if (row === undefined) return
    const entry = row.entry
    switch (entry.type) {
      case 'create': {
        closeCommandPalette()
        if (createKind === 'contact') {
          createContact(
            interp.contact !== undefined
              ? { fn: interp.contact.fn, email: interp.contact.email, tel: interp.contact.tel }
              : { fn: interp.title },
          )
        } else {
          // Fields mode: hand the parsed Interpretation over structurally so
          // the dialog builds the entry without re-running the base grammar
          // (which would drop the recurrence/location overlays and re-merge
          // the title). Optional fields omitted when undefined.
          openQuickAddFields({
            summary: interp.title,
            kind: createKind,
            allDay: interp.allDay,
            ...(interp.when !== undefined ? { start: interp.when } : {}),
            ...(interp.durationMin !== undefined ? { durationMin: interp.durationMin } : {}),
            ...(interp.due !== undefined ? { due: interp.due } : {}),
            ...(interp.rrule !== undefined ? { rrule: interp.rrule } : {}),
            ...(interp.location !== undefined ? { location: interp.location } : {}),
            tags: interp.tags,
            ...(interp.priority !== undefined ? { priority: interp.priority } : {}),
          })
        }
        return
      }
      case 'action':
        closeCommandPalette()
        entry.run()
        return
      case 'event':
        closeCommandPalette()
        gotoCalendarQuery({ date: dayKey(entry.item.when) })
        return
      case 'todo':
        closeCommandPalette()
        gotoCalendarQuery({ view: 'agenda', date: entry.item.when !== null ? dayKey(entry.item.when) : null })
        return
      case 'contact':
        closeCommandPalette()
        requestOpenContact(entry.href)
        window.location.hash = ROUTES.contacts
        return
    }
  }

  function onInputKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (count > 0) setIdx((sel + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (count > 0) setIdx((sel - 1 + count) % count)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runEntry(rows.find((r) => r.idx === sel))
    } else if (e.key === 'Tab') {
      // Always swallowed inside the input (empty query: keep focus); with a
      // query, Tab cycles the create kind forward, Shift+Tab backward.
      e.preventDefault()
      if (trimmed !== '') {
        const dir = e.shiftKey ? -1 : 1
        setKindOverride(CREATE_KINDS[(CREATE_KINDS.indexOf(createKind) + dir + CREATE_KINDS.length) % CREATE_KINDS.length])
      }
    }
    // Escape is handled by the document listener above.
  }

  const chipList = mergeChips(interp.chips)
  const showPreview = selRow !== undefined && selRow.entry.type !== 'action'

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-[20vh]"
      onMouseDown={closeCommandPalette}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        class="wycal-palette-panel flex max-h-[70vh] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          class="input w-full rounded-b-none border-0 border-b border-border px-4 py-3.5 text-lg"
          type="text"
          dir="auto"
          value={draft}
          placeholder="Add event, task, or contact — or search…"
          aria-label="Command palette"
          autoComplete="off"
          spellcheck={false}
          onInput={(e) => setDraft(e.currentTarget.value.replace(/\r\n?|\n/g, ' '))}
          onKeyDown={onInputKeyDown}
        />
        <div class="flex min-h-0 flex-1">
          <div ref={paneRef} class="min-h-0 flex-1 overflow-y-auto p-1.5">
            {rows.map((r) => (
              <ResultRow
                key={r.idx}
                row={r}
                selected={r.idx === sel}
                createKind={createKind}
                interp={interp}
                chips={chipList}
                tokens={hlTokens}
                onSelect={() => setIdx(r.idx)}
                onRun={() => runEntry(r)}
              />
            ))}
            {count === 0 && <p class="px-3 py-6 text-center text-sm text-muted">No matches.</p>}
          </div>
          {showPreview && selRow !== undefined && (
            <div class="max-md:hidden w-60 shrink-0 overflow-y-auto border-l border-border p-3">
              <PreviewCard entry={selRow.entry} interp={interp} createKind={createKind} />
            </div>
          )}
        </div>
        <div class="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted">
          <span>↑↓ move</span>
          <span>⏎ run</span>
          {trimmed !== '' && <span>⇥/⇧⇥ cycle kind ({CREATE_LABEL[createKind]})</span>}
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROW_BASE = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left'
const ROW_SELECTED = 'bg-surface-2'

/** Action glyphs (Icon is a component map, so resolve per icon name). */
const ACTION_ICON = {
  plus: Icon.plus,
  calendar: Icon.calendar,
  users: Icon.users,
  sunMoon: Icon.sunMoon,
} as const

function ResultRow(props: {
  row: Row
  selected: boolean
  createKind: CreateKind
  interp: Interpretation
  chips: Chip[]
  tokens: string[]
  onSelect: () => void
  onRun: () => void
}) {
  const { row, selected } = props
  const cls = `${ROW_BASE} ${selected ? ROW_SELECTED : ''}`
  return (
    <>
      {(row.heading ?? []).map((h) =>
        h.level === 'section' ? (
          <h3 key={h.text} class="px-1 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {h.text}
          </h3>
        ) : (
          <div key={`${h.text}-${row.idx}`} class="pb-0.5 pt-1.5 text-xs font-semibold uppercase text-muted">
            {h.text}
          </div>
        ),
      )}
      <button
        type="button"
        data-idx={row.idx}
        class={cls}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={props.onSelect}
        onClick={props.onRun}
      >
        <RowContent row={row} createKind={props.createKind} interp={props.interp} chips={props.chips} tokens={props.tokens} />
      </button>
    </>
  )
}

function RowContent(props: { row: Row; createKind: CreateKind; interp: Interpretation; chips: Chip[]; tokens: string[] }) {
  const entry = props.row.entry
  switch (entry.type) {
    case 'create':
      return (
        <>
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Icon.plus size={14} />
          </span>
          <span class="shrink-0 text-sm font-semibold text-accent">{CREATE_LABEL[props.createKind]}</span>
          {props.interp.title !== '' ? (
            <span class="min-w-0 truncate text-base text-fg-strong">{props.interp.title}</span>
          ) : (
            <span class="min-w-0 truncate text-base italic text-muted">untitled</span>
          )}
          {props.chips.length > 0 && (
            <span class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
              {props.chips.map((c, i) => (
                <span key={`${c.start}-${i}`} class={`shrink-0 rounded px-1.5 py-0.5 text-xs ${CHIP_CLASS[c.kind]}`}>
                  {/* Render-only: strip a leading 'at '/'for '/'@' (offsets untouched). */}
                  {c.text.trim().replace(/^(?:at|for)\s+|^@/i, '')}
                </span>
              ))}
            </span>
          )}
        </>
      )
    case 'action': {
      const ActionIcon = ACTION_ICON[entry.icon]
      return (
        <>
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
            <ActionIcon size={14} />
          </span>
          <span class="min-w-0 truncate text-base text-fg">{entry.label}</span>
          {entry.hint !== '' && <span class="ml-auto shrink-0 text-xs tabular-nums text-muted">{entry.hint}</span>}
        </>
      )
    }
    case 'event':
      return (
        <>
          <span class="chip-dot shrink-0" style={{ background: entry.item.calColor }} />
          <span class="w-32 shrink-0 text-xs tabular-nums text-muted">
            {entry.item.allDay
              ? fmtDate(entry.item.when)
              : `${fmtDate(entry.item.when)} ${fmtTime(entry.item.when, prefs.value.hour12)}`}
          </span>
          <span class="min-w-0 truncate text-base text-fg-strong">{highlight(entry.item.ev.summary, props.tokens)}</span>
          {entry.item.calName !== '' && <span class="ml-auto truncate pl-2 text-sm text-muted">{entry.item.calName}</span>}
        </>
      )
    case 'todo':
      return (
        <>
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border-strong" />
          {entry.item.prio !== null && (
            <span class={`shrink-0 text-xs font-semibold ${entry.item.prio === 'A' ? 'text-danger' : entry.item.prio === 'B' ? 'text-warning' : 'text-muted'}`}>
              #{entry.item.prio}
            </span>
          )}
          <span class={`min-w-0 truncate text-base ${entry.item.done ? 'text-muted line-through' : 'text-fg-strong'}`}>
            {highlight(entry.item.todo.summary, props.tokens)}
          </span>
          <span class="ml-auto flex shrink-0 items-center gap-2">
            {entry.item.when !== null && <span class="text-xs tabular-nums text-muted">{fmtDate(entry.item.when)}</span>}
            <span class="chip-dot" style={{ background: entry.item.calColor }} />
          </span>
        </>
      )
    case 'contact':
      return (
        <>
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {entry.fn.slice(0, 1).toUpperCase()}
          </span>
          <span class="min-w-0 truncate text-base text-fg-strong">{highlight(entry.fn, props.tokens)}</span>
          {entry.detail !== '' && <span class="ml-auto min-w-0 truncate pl-2 text-sm text-muted">{entry.detail}</span>}
        </>
      )
  }
}

// ---------------------------------------------------------------------------
// Detail preview (Raycast-style right card)
// ---------------------------------------------------------------------------

function PreviewRows(props: { rows: [string, string][] }) {
  return (
    <dl class="space-y-1.5">
      {props.rows.map(([label, value]) => (
        <div key={label}>
          <dt class="text-xs text-muted">{label}</dt>
          <dd class="text-sm text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function PreviewTags(props: { tags: string[] }) {
  if (props.tags.length === 0) return null
  return (
    <div class="flex flex-wrap gap-1">
      {props.tags.map((t) => (
        <span key={t} class="tag-chip">
          {t}
        </span>
      ))}
    </div>
  )
}

function PreviewCard(props: { entry: Entry; interp: Interpretation; createKind: CreateKind }) {
  const entry = props.entry
  const p = props.interp
  const title =
    entry.type === 'create'
      ? p.title !== ''
        ? p.title
        : 'untitled'
      : entry.type === 'event'
        ? entry.item.ev.summary
        : entry.type === 'todo'
          ? entry.item.todo.summary
          : entry.type === 'contact'
            ? entry.fn
            : ''
  return (
    <div class="space-y-2.5">
      <h4 class="break-words text-base font-semibold text-fg-strong">{title}</h4>
      {entry.type === 'create' && props.createKind === 'event' && (
        <>
          <PreviewRows
            rows={[
              ...(p.due !== undefined ? ([['When', `${fmtWhen(p.due, p.allDay)}${p.allDay ? ' · all-day' : ''}`]] as [string, string][]) : []),
              ...(p.durationMin !== undefined && !p.allDay ? ([['Duration', fmtMinutes(p.durationMin)]] as [string, string][]) : []),
              ...(p.rrule !== undefined ? ([['Repeats', describeRrule(p.rrule)]] as [string, string][]) : []),
              ...(p.location !== undefined ? ([['Where', p.location]] as [string, string][]) : []),
              ...(p.priority !== undefined ? ([['Priority', `#${prioLetter(p.priority)}`]] as [string, string][]) : []),
            ]}
          />
          <PreviewTags tags={p.tags} />
        </>
      )}
      {entry.type === 'create' && props.createKind === 'todo' && (
        <>
          <PreviewRows
            rows={[
              ...(p.due !== undefined ? ([['Due', fmtWhen(p.due, p.allDay)]] as [string, string][]) : []),
              ...(p.priority !== undefined ? ([['Priority', `#${prioLetter(p.priority)}`]] as [string, string][]) : []),
            ]}
          />
          <PreviewTags tags={p.tags} />
        </>
      )}
      {entry.type === 'create' && props.createKind === 'contact' && (
        <PreviewRows
          rows={[
            ...(p.contact?.email !== undefined ? ([['Email', p.contact.email]] as [string, string][]) : []),
            ...(p.contact?.tel !== undefined ? ([['Phone', p.contact.tel]] as [string, string][]) : []),
          ]}
        />
      )}
      {entry.type === 'event' && (
        <>
          <PreviewRows
            rows={[
              ['When', fmtRange(entry.item.when, icsDateToDate(entry.item.ev.end), entry.item.allDay)],
              ...(entry.item.ev.rrule !== undefined ? ([['Repeats', describeRrule(entry.item.ev.rrule)]] as [string, string][]) : []),
              ...(entry.item.ev.location !== undefined && entry.item.ev.location !== '' ? ([['Where', entry.item.ev.location]] as [string, string][]) : []),
              ['Calendar', entry.item.calName],
            ]}
          />
          <PreviewTags tags={entry.item.categories} />
        </>
      )}
      {entry.type === 'todo' && (
        <>
          <PreviewRows
            rows={[
              [
                'Due',
                entry.item.due !== null
                  ? fmtWhen(entry.item.due, entry.item.allDay)
                  : entry.item.when !== null
                    ? fmtWhen(entry.item.when, entry.item.allDay)
                    : 'No due date',
              ],
              ...(entry.item.prio !== null ? ([['Priority', `#${entry.item.prio}`]] as [string, string][]) : []),
              ['Calendar', entry.item.calName],
            ]}
          />
          <PreviewTags tags={entry.item.categories} />
        </>
      )}
      {entry.type === 'contact' && (
        <PreviewRows
          rows={[
            ...(entry.detail !== '' ? ([['Contact', entry.detail]] as [string, string][]) : []),
            ...(entry.org !== undefined && entry.org !== '' ? ([['Org', entry.org]] as [string, string][]) : []),
          ]}
        />
      )}
    </div>
  )
}
