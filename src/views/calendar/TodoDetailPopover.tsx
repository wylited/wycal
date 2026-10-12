/** @jsxImportSource preact */
/**
 * Todo detail popover (§22 pattern, mirrors EventDetailPopover): a single
 * click on a calendar todo chip opens this compact card instead of the task
 * editor — quick status/priority/due actions stay one click, the full editor
 * moves behind Edit. Anchored to the clicked element, viewport-clamped,
 * .card chrome. Closes on Esc and outside click; registers with the global
 * dialog gate (stores/ui) while mounted so global shortcuts are suppressed.
 * Delete goes through deleteTodo, which owns the 'Task deleted' + Undo toast.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  cycleTodoStatus,
  deleteTodo,
  setTodoDue,
  setTodoPriority,
  todoKey,
  todos,
} from '../../stores/todos'
import type { TodoRecord } from '../../stores/todos'
import { collections } from '../../stores/calendars'
import { prefs } from '../../stores/prefs'
import { addDays, fmtDate, fmtTime } from '../../lib/util/date'
import { icsDateToDate, prioLetter, shiftIcsDate, toIcsDateInput } from '../../lib/ics/types'
import type { IcsDate, IcsTodo } from '../../lib/ics/types'
import { eventColorFor } from '../../lib/util/colors'
import { openTodoEditor } from '../tasks/todoEditor'
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui'
import { Icon } from '../../ui/icons'

const WIDTH = 340
const DAY_MS = 24 * 60 * 60 * 1000

/** #A/#B/#C quick bands (same values TasksView's editor writes via PRIO_VALUE). */
const PRIO_VALUE = { A: 1, B: 4, C: 7 } as const

/** STATUS → chip label (org Todo/Doing/Done parity). */
function statusLabel(status: IcsTodo['status']): string {
  if (status === 'IN-PROCESS') return 'Doing'
  if (status === 'COMPLETED') return 'Done'
  if (status === 'CANCELLED') return 'Cancelled'
  return 'Todo'
}

/** Next link in the Todo → Doing → Done → Todo cycle (CANCELLED counts as Todo). */
function nextStatus(status: IcsTodo['status']): IcsTodo['status'] {
  if (status === 'COMPLETED') return 'NEEDS-ACTION'
  if (status === 'IN-PROCESS') return 'COMPLETED'
  return 'IN-PROCESS'
}

/** `Due Oct 9` (all-day) / `Due Wed, Oct 9 · 14:00` (timed); lone DTSTART → `Scheduled …`. */
function whenText(td: IcsTodo): { due: string | null; sched: string | null } {
  const { hour12 } = prefs.value
  const fmt = (d: IcsDate): string => {
    const date = icsDateToDate(d)
    return d.date !== undefined
      ? fmtDate(date)
      : `${fmtDate(date, { weekday: true })} · ${fmtTime(date, hour12)}`
  }
  return {
    due: td.due ? `Due ${fmt(td.due)}` : null,
    sched: td.dtstart ? `Scheduled ${fmt(td.dtstart)}` : null,
  }
}

/**
 * Two-step delete confirm, same pattern as the event popover/editor
 * (CONTRACTS §21): the first `activate` arms — the Delete button turns into
 * danger 'Sure?' — the second deletes; a 3s timer reverts. File-local to the
 * views owning delete affordances.
 */
function useConfirmDelete(remove: () => void) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  function disarm() {
    setArmed(false)
    window.clearTimeout(timer.current)
  }
  function activate() {
    if (armed) {
      disarm()
      void remove()
      return
    }
    setArmed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(disarm, 3000)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { armed, activate, disarm }
}

export function TodoDetailPopover(props: {
  record: TodoRecord
  anchor: HTMLElement
  onClose: () => void
}) {
  // Live record: the quick actions PUT through the store, which swaps the
  // todos Map — reading the signal here re-renders the chips from current data.
  const rec = todos.value.get(todoKey(props.record.data.uid, props.record.calendarUrl)) ?? props.record
  const td = rec.data
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Compute once from the clicked element; clamp to the viewport on all edges.
  const [pos] = useState(() => {
    const rect = props.anchor.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - 16)
    const top = Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 320))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    return { top, left, width }
  })

  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    const anchor = props.anchor
    return () => {
      document.removeEventListener('keydown', onKey)
      anchor.focus()
    }
  }, [])

  // Global dialog gate while open (CONTRACTS §16): shortcuts are suppressed.
  useEffect(() => {
    bumpDialogOpen()
    return bumpDialogClose
  }, [])

  const cal = collections.value.find((c) => c.url === rec.calendarUrl)
  const color = eventColorFor({ color: td.color, calendarUrl: rec.calendarUrl })
  const tags = td.categories.filter(Boolean)
  const when = whenText(td)

  const edit = () => {
    props.onClose()
    openTodoEditor(rec)
  }

  // Quick-action cycle targets — each button label shows where the next
  // click lands (Todo → Doing → Done → Todo; #A → #B → #C → none).
  const status = nextStatus(td.status)
  const letter = prioLetter(td.priority)
  const nextPrio: 'A' | 'B' | 'C' | undefined =
    letter === 'A' ? 'B' : letter === 'B' ? 'C' : letter === 'C' ? undefined : 'A'

  /** Due +1d, preserving the all-day/timed form; no due yet → tomorrow (all-day). */
  function bumpDue(): void {
    const base = td.due ?? td.dtstart
    void setTodoDue(rec, base ? shiftIcsDate(base, DAY_MS) : toIcsDateInput(addDays(new Date(), 1), true))
  }

  const [deleting, setDeleting] = useState(false)

  /**
   * Direct delete via the store: deleteTodo captures the undo payload before
   * the DELETE and pushes the 'Task deleted' + Undo toast itself (same path
   * as the task rows). On failure the store rolls back + toasts; the popover
   * stays open.
   */
  async function remove(): Promise<void> {
    setDeleting(true)
    try {
      await deleteTodo(rec)
      props.onClose()
    } catch {
      // Store rolled back + toasted; keep the popover open.
    } finally {
      setDeleting(false)
    }
  }

  // Two-step confirm (CONTRACTS §21), same as the event popover: first click
  // arms, second deletes; 3s revert. Any other panel click disarms, and
  // Esc/outside click close the popover, which disarms via unmount cleanup.
  const del = useConfirmDelete(remove)

  return (
    <>
      <div class="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={td.summary || 'Task details'}
        tabIndex={-1}
        class="card fixed z-50 flex flex-col gap-2 shadow-[var(--shadow-2)] outline-none"
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxWidth: `${WIDTH}px` }}
        onClick={() => {
          if (del.armed) del.disarm()
        }}
      >
        <div class="flex items-start gap-1.5">
          <h3 class="min-w-0 flex-1 break-words text-sm font-semibold text-fg-strong">
            {td.summary || '(no title)'}
          </h3>
          <button type="button" class="btn btn-ghost btn-sm icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon.x size={13} />
          </button>
        </div>

        <p class="flex flex-wrap items-center gap-1.5 text-xs text-fg">
          <span class="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">{statusLabel(td.status)}</span>
          {letter !== null && (
            <span class="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">#{letter}</span>
          )}
          {when.due && <span class="tabular-nums">{when.due}</span>}
          {when.sched && <span class="tabular-nums text-muted">{when.sched}</span>}
        </p>

        {cal && (
          <p class="flex items-center gap-1.5 text-xs text-muted">
            <span class="chip-dot" style={{ '--chip-color': color }} aria-hidden="true" />
            {cal.name}
          </p>
        )}

        {td.description && (
          <p class="line-clamp-4 whitespace-pre-line break-words text-xs text-muted">{td.description}</p>
        )}

        {tags.length > 0 && (
          <div class="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} class="tag-chip">{t}</span>
            ))}
          </div>
        )}

        <div class="mt-1 flex items-center gap-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm flex-1"
            title="Cycle status (Todo → Doing → Done → Todo)"
            disabled={deleting}
            onClick={() => void cycleTodoStatus(rec)}
          >
            → {statusLabel(status)}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm flex-1"
            title="Cycle priority (#A → #B → #C → none)"
            disabled={deleting}
            onClick={() => void setTodoPriority(rec, nextPrio === undefined ? undefined : PRIO_VALUE[nextPrio])}
          >
            {nextPrio === undefined ? 'No prio' : `#${nextPrio}`}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm flex-1"
            title={td.due ? 'Push the due date one day later' : 'Set the due date to tomorrow'}
            disabled={deleting}
            onClick={bumpDue}
          >
            Due +1d
          </button>
        </div>

        <div class="flex items-center gap-2">
          <button type="button" class="btn btn-primary btn-sm flex-1" title="Edit task" onClick={edit}>
            Edit
          </button>
          <button
            type="button"
            class={`btn btn-sm ${del.armed ? 'btn-danger' : 'btn-ghost text-danger'}`}
            title={del.armed ? 'Click again to delete' : 'Delete task'}
            aria-label={del.armed ? 'Click again to delete' : 'Delete task'}
            disabled={deleting}
            onClick={del.activate}
          >
            {del.armed ? 'Sure?' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  )
}
