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
import { prioLetter } from '@wycal/core/lib/ics/types'
import type { Interpretation } from '@wycal/core/nl/nl'
import {
  DEFAULT_EVENT_MINUTES,
  describeRecurrence,
  eventFromInterpretation,
  interpretationFromFields,
  interpretationFromLine,
  planEventDraft,
  todoFromInterpretation,
  type QuickAddFields,
} from '@wycal/core/nl/draft'
import { collections, isCalendarVisible } from '@wycal/core/stores/calendars'
import { createEvent, deleteEvent } from '@wycal/core/stores/events'
import { createTodo, deleteTodo } from '@wycal/core/stores/todos'
import { push } from '@wycal/core/stores/toasts'
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui'
import { Modal } from '../../ui/Modal'
import { describeDue, parseQuickAddLine, type ParsedQuickAddLine, type QuickAddKind } from '@wycal/core/nl/quickAdd'

/** Dialog entry mode: 'auto' trusts the line's own kind inference. */
export type QuickAddMode = 'auto' | 'event' | 'todo'

export type { QuickAddFields }

interface QuickAddRequest {
  mode: QuickAddMode
  prefill: string
  /** Structured palette prefill (openQuickAddFields): fields mode — the line
   *  is NEVER re-parsed, the entry is built from these fields directly. */
  fields?: QuickAddFields
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

/** Open the dialog in fields mode (palette create path): the input holds
 *  `f.summary` (still editable — the raw text becomes the saved summary),
 *  the kind chip is locked to `f.kind`, and Enter creates from `f`'s fields
 *  (rrule, location, tags, priority, due/start) with no grammar re-parse. */
export function openQuickAddFields(f: QuickAddFields): void {
  request.value = { mode: f.kind, prefill: f.summary, fields: f, seq: ++seqCounter }
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

/** Inline failure line under the preview: toasts can go unseen while the
 *  dialog stays open (store also toasts on rollback), so the dialog itself
 *  must say the create failed. Shown on every failure path. */
const CREATE_ERROR_TEXT = 'Create failed — check your password in Settings, then retry.'

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

/** '5:00pm–6:00pm', or '3:00pm – Thu 1:00pm' when the end lands on a
 *  different local day (cross-midnight durations would otherwise show a
 *  nonsensical '3:00pm–1:00pm'). Shared by describeEntry and describeFields
 *  so the parse path and the palette-forwarded fields path agree. */
function describeRange(start: Date, end: Date): string {
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  return sameDay
    ? `${fmtTime(start)}–${fmtTime(end)}`
    : `${fmtTime(start)} – ${format(end, 'EEE ')}${fmtTime(end)}`
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
    const plan = planEventDraft(interpretationFromLine(p, 'event'))
    bits.push(format(plan.start, 'EEE MMM d'))
    bits.push(plan.allDay ? 'all-day' : describeRange(plan.start, plan.end))
  } else if (p.dueOrStart !== undefined) {
    bits.push(describeDue(p.dueOrStart))
  }
  const letter = prioLetter(p.priority)
  if (letter !== null) bits.push(`#${letter}`)
  for (const tag of p.tags) bits.push(`+${tag}`)
  if (cal !== undefined) bits.push(cal.name)
  return `→ ${bits.join(' · ')}`
}

/** Fields-mode preview: describes exactly what Enter will create — the line
 *  is never re-parsed here, so the hint cannot drift from the fields. */
function describeFields(f: QuickAddFields, cal: { name: string } | undefined): string {
  if (f.summary === '') return ''
  const bits: string[] = [f.kind === 'event' ? 'Event' : 'Task']
  if (f.kind === 'event') {
    const base = f.start ?? new Date()
    // All-day pins local midnight of the parsed day (planEvent idiom).
    const start = f.allDay === true ? new Date(base.getFullYear(), base.getMonth(), base.getDate()) : base
    bits.push(format(start, 'EEE MMM d'))
    if (f.allDay === true) {
      bits.push('all-day')
    } else {
      const end = new Date(start.getTime() + (f.durationMin ?? DEFAULT_EVENT_MINUTES) * 60_000)
      bits.push(describeRange(start, end))
    }
    if (f.rrule !== undefined) bits.push(describeRecurrence(f.rrule))
    if (f.location !== undefined && f.location !== '') bits.push(`@${f.location}`)
  } else {
    // Midnight wall → day-precision (all-day) due; a carried time stays timed.
    if (f.due !== undefined) {
      bits.push(describeDue({ date: f.due, allDay: f.due.getHours() === 0 && f.due.getMinutes() === 0 }))
    }
    if (f.priority != null) {
      const letter = prioLetter(f.priority)
      if (letter !== null) bits.push(`#${letter}`)
    }
  }
  for (const tag of f.tags ?? []) bits.push(`+${tag}`)
  if (cal !== undefined) bits.push(cal.name)
  return `→ ${bits.join(' · ')}`
}

/** One dialog session (remounted per open via key). */
function QuickAddCard(props: { initial: QuickAddRequest }) {
  /** Fields mode (palette create path): no grammar re-parse, kind locked. */
  const fields = props.initial.fields ?? null
  const [mode, setMode] = useState<QuickAddMode>(props.initial.mode)
  const [text, setText] = useState(props.initial.prefill)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Autofocus per open (the key above remounts us); a prefill selects so the
  // next keystroke replaces it.
  useEffect(() => {
    inputRef.current?.focus()
    if (props.initial.prefill !== '') inputRef.current?.select()
  }, [])

  const parsed = useMemo(() => parseQuickAddLine(text), [text])
  const kind: QuickAddKind = fields !== null ? fields.kind : mode === 'auto' ? parsed.kind : mode
  const cal = calsFor(kind)[0]
  const preview = fields !== null ? describeFields(fields, cal) : describeEntry(kind, parsed, cal)

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
      // stop for it, so it never leaves the field. Fields mode: the kind is
      // locked, so Tab only keeps focus in the field.
      e.preventDefault()
      if (fields === null) cycleMode(e.shiftKey ? -1 : 1)
    }
  }

  /** Create via the shared core builders (nl/draft) + the Undo toast
   *  (design §5: the store delete owns its 'deleted' + Undo toast). */
  async function create(interp: Interpretation, kind: QuickAddKind, target: { url: string }): Promise<void> {
    if (kind === 'todo') {
      const todo = todoFromInterpretation(interp)
      const rec = await createTodo(target.url, todo)
      push('success', `Created ${todo.summary}`, {
        label: 'Undo',
        run: () => void deleteTodo(rec).catch(() => {}),
      })
    } else {
      const ev = eventFromInterpretation(interp)
      const rec = await createEvent(target.url, ev)
      push('success', `Created ${ev.summary}`, {
        label: 'Undo',
        run: () => void deleteEvent(rec, 'all').catch(() => {}),
      })
    }
  }

  async function submit(): Promise<void> {
    if (text.trim() === '' || busy) return
    // New attempt: the previous failure line goes away (also via onInput).
    setCreateError(null)
    if (fields !== null) return submitFields(fields, text.trim())
    const line = text
    const p = parseQuickAddLine(line)
    const k: QuickAddKind = mode === 'auto' ? p.kind : mode
    if (p.summary === '') return
    const target = calsFor(k)[0]
    if (target === undefined) {
      push('error', `No visible calendar for new ${k === 'todo' ? 'tasks' : 'events'}`)
      setCreateError(CREATE_ERROR_TEXT)
      return
    }
    setBusy(true)
    try {
      await create(interpretationFromLine(p, k), k, target)
      closeQuickAdd()
    } catch {
      // Store rolled back + toasted (CONTRACTS §4); keep the dialog open.
      setBusy(false)
      setCreateError(CREATE_ERROR_TEXT)
    }
  }

  /** Fields-mode create: build the entry straight from the palette's fields
   *  (no grammar re-parse) — exactly what the preview described. */
  async function submitFields(f: QuickAddFields, summary: string): Promise<void> {
    const target = calsFor(f.kind)[0]
    if (target === undefined) {
      push('error', `No visible calendar for new ${f.kind === 'todo' ? 'tasks' : 'events'}`)
      setCreateError(CREATE_ERROR_TEXT)
      return
    }
    setBusy(true)
    try {
      await create(interpretationFromFields(f, summary), f.kind, target)
      closeQuickAdd()
    } catch {
      // Store rolled back + toasted (CONTRACTS §4); keep the dialog open.
      setBusy(false)
      setCreateError(CREATE_ERROR_TEXT)
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
          onInput={(e) => {
            setText(e.currentTarget.value)
            setCreateError(null)
          }}
          onKeyDown={onInputKeyDown}
        />
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1" role="group" aria-label="Entry type">
            {(fields !== null ? MODES.filter((m) => m.value === fields.kind) : MODES).map((m) => (
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
        {createError !== null && (
          <div class="text-xs text-danger" role="alert">
            {createError}
          </div>
        )}
      </div>
    </Modal>
  )
}
