/** @jsxImportSource preact */
/**
 * Global quick-add dialog (CONTRACTS §16 Q, KashCal-inspired): one input that
 * becomes an event or a task via natural language (tasks/quickAdd
 * `parseQuickAddLine` — 'Team sync fri 2pm', 'Milk tomorrow #A +home',
 * 'todo: call mom'). Mode chips auto/event/task (Tab cycles, aria-pressed), a
 * live preview line that mirrors the exact parse Enter applies, Enter creates
 * in the first visible VEVENT/VTODO calendar, and a 'Created …' toast with a
 * 6s Undo (the store delete keeps its own undo toast, design.md §5). Esc /
 * backdrop close through the shared Modal trap, which restores focus.
 *
 * Mounted once by app.tsx next to EventEditor; any component can call
 * `openQuickAdd(mode?, prefill?)` — the request travels through a
 * module-level signal (todoEditor.ts pattern), so no wiring is needed at the
 * callsite.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { format } from 'date-fns'
import { signal } from '@preact/signals'
import type { IcsDate, IcsEvent, IcsTodo } from '../../lib/ics/types'
import { prioLetter, toIcsDateInput } from '../../lib/ics/types'
import { newUid } from '../../lib/util/id'
import { collections, isCalendarVisible } from '../../stores/calendars'
import { createEvent, deleteEvent } from '../../stores/events'
import { createTodo, deleteTodo } from '../../stores/todos'
import { push } from '../../stores/toasts'
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui'
import { Modal } from '../../ui/Modal'
import {
  describeDue,
  parseQuickAddLine,
  type ParsedQuickAddLine,
  type QuickAddDue,
  type QuickAddKind,
} from '../tasks/quickAdd'

/** Dialog entry mode: 'auto' trusts the line's own kind inference. */
export type QuickAddMode = 'auto' | 'event' | 'todo'

interface QuickAddRequest {
  mode: QuickAddMode
  prefill: string
  /** Monotonic open counter: a key so re-opens remount (fresh state + autofocus). */
  seq: number
}

/** Pending open request, or null while closed (todoEditor.ts pattern). */
const request = signal<QuickAddRequest | null>(null)
let seqCounter = 0

/** Open the global quick-add dialog (Q, TasksView/Sidebar buttons, …). */
export function openQuickAdd(mode: QuickAddMode = 'auto', prefill = ''): void {
  request.value = { mode, prefill, seq: ++seqCounter }
}

/** Close the dialog, discarding the draft (Modal Esc/backdrop funnel here). */
export function closeQuickAdd(): void {
  request.value = null
}

/** Mounted once by app.tsx; renders the dialog from the `request` signal. */
export function QuickAddDialog() {
  const req = request.value
  const open = req !== null
  // Register as an open dialog (stores/ui) so global keybinds gate while up.
  useEffect(() => {
    if (!open) return
    bumpDialogOpen()
    return bumpDialogClose
  }, [open])
  if (req === null) return null
  return <QuickAddCard key={req.seq} initial={req} />
}

const MODES: { value: QuickAddMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Detect event or task from the text' },
  { value: 'event', label: 'Event', title: 'Always create an event' },
  { value: 'todo', label: 'Task', title: 'Always create a task' },
]

const DAY_MS = 86_400_000
/** Timed events default to 60m when the line parsed no duration (§16 Q). */
const DEFAULT_EVENT_MINUTES = 60

/** Strictly-next half-hour boundary (mirrors stores/ui nextHalfHour:
 *  14:00:23 → 14:30, 14:30:00 → 15:00). */
function nextHalfHour(): Date {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 30))
  return d
}

interface EventPlan {
  start: Date
  end: Date
  allDay: boolean
}

/**
 * Event fields from a parsed line: a timed token → start there, end at the
 * parsed duration (default 60m); a duration token without a wall time → timed
 * at the next half-hour (a duration implies a timed event); a date-only match
 * or nothing → an all-day event on that date (today when none).
 */
function planEvent(p: ParsedQuickAddLine): EventPlan {
  if (p.dueOrStart !== undefined && !p.dueOrStart.allDay) {
    const start = p.dueOrStart.date
    return { start, end: new Date(start.getTime() + (p.durationMinutes ?? DEFAULT_EVENT_MINUTES) * 60_000), allDay: false }
  }
  if (p.durationMinutes !== undefined) {
    const day = p.dueOrStart?.date
    const nh = nextHalfHour()
    const start =
      day === undefined
        ? nh
        : new Date(day.getFullYear(), day.getMonth(), day.getDate(), nh.getHours(), nh.getMinutes())
    return { start, end: new Date(start.getTime() + p.durationMinutes * 60_000), allDay: false }
  }
  const day = p.dueOrStart !== undefined ? p.dueOrStart.date : new Date()
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  return { start, end: new Date(start.getTime() + DAY_MS), allDay: true }
}

/** Parsed due → IcsDate: all-day → VALUE=DATE form; timed → floating wall
 *  time (the exact form TasksView's quick-add writes). */
function todoDue(d: QuickAddDue): IcsDate {
  if (d.allDay) return toIcsDateInput(new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate()), true)
  const wall = new Date(
    Date.UTC(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), d.date.getHours(), d.date.getMinutes()),
  )
  return { utc: wall.toISOString(), floating: true }
}

/** Visible calendars accepting this kind, collection order (first = default)
 *  — TasksView quick-add parity, with VEVENT for events / VTODO for tasks. */
function calsFor(kind: QuickAddKind): { url: string; name: string }[] {
  const comp = kind === 'todo' ? 'VTODO' : 'VEVENT'
  return collections.value
    .filter((c) => c.kind === 'calendar' && c.components.includes(comp) && isCalendarVisible(c.url))
    .map((c) => ({ url: c.url, name: c.name || c.url }))
}

/** '5:00pm' — same 12h wall form describeDue uses. */
function fmtTime(d: Date): string {
  const h24 = d.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`
}

/**
 * Live hint ('→ Event · Fri Oct 16 · 5:00pm–6:00pm · Personal' / '→ Task ·
 * Fri Oct 16 · #A · +home · Personal') — computed from the same parse Enter
 * applies, so the preview never lies. Empty until the summary has text.
 */
function describeEntry(kind: QuickAddKind, p: ParsedQuickAddLine, cal: { name: string } | undefined): string {
  if (p.summary === '') return ''
  const bits: string[] = [kind === 'event' ? 'Event' : 'Task']
  if (kind === 'event') {
    const plan = planEvent(p)
    bits.push(format(plan.start, 'EEE MMM d'))
    bits.push(plan.allDay ? 'all-day' : `${fmtTime(plan.start)}–${fmtTime(plan.end)}`)
  } else if (p.dueOrStart !== undefined) {
    bits.push(describeDue(p.dueOrStart))
  }
  const letter = prioLetter(p.priority)
  if (letter !== null) bits.push(`#${letter}`)
  for (const tag of p.tags) bits.push(`+${tag}`)
  if (cal !== undefined) bits.push(cal.name)
  return `→ ${bits.join(' · ')}`
}

/** One dialog session (remounted per open via key). */
function QuickAddCard(props: { initial: QuickAddRequest }) {
  const [mode, setMode] = useState<QuickAddMode>(props.initial.mode)
  const [text, setText] = useState(props.initial.prefill)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Autofocus per open (the key above remounts us); a prefill selects so the
  // next keystroke replaces it.
  useEffect(() => {
    inputRef.current?.focus()
    if (props.initial.prefill !== '') inputRef.current?.select()
  }, [])

  const parsed = useMemo(() => parseQuickAddLine(text), [text])
  const kind: QuickAddKind = mode === 'auto' ? parsed.kind : mode
  const cal = calsFor(kind)[0]
  const preview = describeEntry(kind, parsed, cal)

  function cycleMode(dir: 1 | -1): void {
    const i = MODES.findIndex((m) => m.value === mode)
    setMode(MODES[(i + dir + MODES.length) % MODES.length].value)
  }

  function onInputKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Tab') {
      // Tab (⇧Tab) cycles the mode chip; the one-input dialog has no other
      // stop for it, so it never leaves the field.
      e.preventDefault()
      cycleMode(e.shiftKey ? -1 : 1)
    }
  }

  async function submit(): Promise<void> {
    const line = text
    if (line.trim() === '' || busy) return
    const p = parseQuickAddLine(line)
    const k: QuickAddKind = mode === 'auto' ? p.kind : mode
    if (p.summary === '') return
    const target = calsFor(k)[0]
    if (target === undefined) {
      push('error', `No visible calendar for new ${k === 'todo' ? 'tasks' : 'events'}`)
      return
    }
    setBusy(true)
    try {
      if (k === 'todo') {
        const todo: IcsTodo = {
          uid: newUid(),
          summary: p.summary,
          status: 'NEEDS-ACTION',
          categories: p.tags,
          priority: p.priority,
          due: p.dueOrStart !== undefined ? todoDue(p.dueOrStart) : undefined,
          exdates: [],
          alarms: [],
        }
        const rec = await createTodo(target.url, todo)
        // Undo (design §5): the store delete owns its 'deleted' + Undo toast.
        push('success', `Created ${todo.summary}`, {
          label: 'Undo',
          run: () => void deleteTodo(rec).catch(() => {}),
        })
      } else {
        const plan = planEvent(p)
        const ev: IcsEvent = {
          uid: newUid(),
          summary: p.summary,
          start: toIcsDateInput(plan.start, plan.allDay),
          end: toIcsDateInput(plan.end, plan.allDay),
          allDay: plan.allDay,
          categories: p.tags,
          exdates: [],
          attendees: [],
          alarms: [],
        }
        const rec = await createEvent(target.url, ev)
        push('success', `Created ${ev.summary}`, {
          label: 'Undo',
          run: () => void deleteEvent(rec, 'all').catch(() => {}),
        })
      }
      closeQuickAdd()
    } catch {
      // Store rolled back + toasted (CONTRACTS §4); keep the dialog open.
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="Quick add"
      width={520}
      onClose={closeQuickAdd}
      footer={
        <>
          <span class="mr-auto text-xs text-muted">Enter create · Tab type · Esc cancel</span>
          <button type="button" class="btn btn-ghost" disabled={busy} onClick={closeQuickAdd}>
            Cancel
          </button>
          <button
            type="button" class="btn btn-primary" title="Create (Enter)"
            disabled={busy || text.trim() === ''} onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-2">
        <input
          ref={inputRef}
          class="input w-full"
          value={text}
          autoFocus
          spellcheck={false}
          placeholder="Team sync fri 2pm · Milk tomorrow #A +home · todo: call mom"
          aria-label="Quick add event or task"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={onInputKeyDown}
        />
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1" role="group" aria-label="Entry type">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                class={m.value === mode ? 'btn btn-primary' : 'btn btn-ghost'}
                aria-pressed={m.value === mode}
                title={m.title}
                onClick={() => setMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {preview !== '' && (
          <div class="text-xs text-muted" role="status" aria-live="polite">
            {preview}
          </div>
        )}
      </div>
    </Modal>
  )
}
