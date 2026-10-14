/** @jsxImportSource preact */
/**
 * Event detail popover (CONTRACTS §22): a single click on an event opens this
 * compact card instead of the editor — the common "what/when/where" check
 * stays one click, the full editor moves behind Edit (Google Calendar
 * pattern, research §1). Anchored to the clicked element, viewport-clamped,
 * max-width 340px, .card chrome. Closes on Esc and outside click; registers
 * with the global dialog gate (stores/ui) while mounted so global shortcuts
 * are suppressed.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { deleteEvent, overrides, restoreEvent } from '../../stores/events'
import type { EventDeleteUndo, EventRecord } from '../../stores/events'
import { collections } from '../../stores/calendars'
import { prefs } from '../../stores/prefs'
import { push } from '../../stores/toasts'
import { addDays, dayKey, fmtDate, fmtTime } from '../../lib/util/date'
import { serializeIcsEvent } from '../../lib/ics/serialize'
import { icsDateToDate } from '../../lib/ics/types'
import { eventColorFor } from '../../lib/util/colors'
import { openEditor } from '../event-editor/editorState'
import { bumpPopoverClose, bumpPopoverOpen } from '../../stores/ui'
import { Icon } from '../../ui/icons'

const WIDTH = 340

/** Human range for the popover: `Wed, Oct 9 · 14:00 – 15:30`, cross-day
 * `Oct 9 14:00 – Oct 10 09:00`, all-day `Oct 9` / `Oct 9 – Oct 11`
 * (ICS DTEND is exclusive, so the all-day display end steps back one day). */
function timeRangeText(record: EventRecord): string {
  const ev = record.data
  const s = icsDateToDate(ev.start)
  const e = ev.end ? icsDateToDate(ev.end) : undefined
  const { hour12 } = prefs.value
  if (ev.allDay) {
    if (e && dayKey(e) !== dayKey(s)) return `${fmtDate(s)} – ${fmtDate(addDays(e, -1))}`
    return fmtDate(s)
  }
  if (e && dayKey(e) !== dayKey(s)) {
    return `${fmtDate(s, { weekday: true })} ${fmtTime(s, hour12)} – ${fmtDate(e, { weekday: true })} ${fmtTime(e, hour12)}`
  }
  const day = fmtDate(s, { weekday: true })
  return e ? `${day} · ${fmtTime(s, hour12)} – ${fmtTime(e, hour12)}` : day
}

/**
 * ⌫/Delete keybind path (CalendarView §22): routes to the editor, which owns
 * the two-step confirm delete. (The popover's own Delete button is wired
 * directly to deleteEvent + undo.)
 */
export function requestDeleteEvent(record: EventRecord): void {
  openEditor({ mode: 'edit', record })
}

/**
 * Two-step delete confirm, same pattern as the editor (CONTRACTS §21): the
 * first `activate` arms — the Delete button turns into danger 'Sure?' — the
 * second deletes; a 3s timer reverts. File-local to the views owning delete
 * affordances.
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

export function EventDetailPopover(props: {
  record: EventRecord
  anchor: HTMLElement
  onClose: () => void
}) {
  const record = props.record
  const ev = record.data
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Compute once from the clicked element; clamp to the viewport on all edges.
  const [pos] = useState(() => {
    const rect = props.anchor.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - 16)
    const top = Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 280))
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
    bumpPopoverOpen()
    return bumpPopoverClose
  }, []);

  const cal = collections.value.find((c) => c.url === record.calendarUrl)
  const color = eventColorFor(record)
  const tags = ev.categories.filter(Boolean)

  const edit = () => {
    props.onClose()
    openEditor({ mode: 'edit', record })
  }

  const [deleting, setDeleting] = useState(false)

  /**
   * Direct delete, mirroring EventEditor.remove(): capture the undo payload
   * BEFORE the delete — only a plain, standalone VEVENT is restorable by
   * re-PUTting the captured body (restoreEvent); series/occurrence deletes
   * rewrite or remove several objects → plain toast, no action. Scope routing
   * matches the editor too: 'all' deletes the standalone object, and for a
   * recurring master or occurrence deletes the whole series (the popover has
   * no scope picker). On failure the store rolls back + toasts; popover stays.
   */
  async function remove() {
    setDeleting(true)
    const plainDelete =
      !ev.rrule &&
      !ev.recurrenceId &&
      ![...overrides.value.values()].some((r) => r.calendarUrl === record.calendarUrl && r.data.uid === ev.uid)
    const undo: EventDeleteUndo | null = plainDelete
      ? {
          calendarUrl: record.calendarUrl,
          uid: ev.uid,
          href: record.href,
          body: serializeIcsEvent(ev),
          data: ev,
        }
      : null
    try {
      await deleteEvent(record, 'all')
      if (undo) push('info', 'Event deleted', { label: 'Undo', run: () => restoreEvent(undo) })
      else push('info', 'Series deleted')
      props.onClose()
    } catch {
      // Store rolled back + toasted; keep the popover open.
    } finally {
      setDeleting(false)
    }
  }

  // Two-step confirm (CONTRACTS §21), same as the editor: first click arms,
  // second deletes; 3s revert. Any other panel click disarms, and Esc/outside
  // click close the popover, which disarms via unmount cleanup.
  const del = useConfirmDelete(remove)

  return (
    <>
      <div class="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={ev.summary || 'Event details'}
        tabIndex={-1}
        class="card fixed z-50 flex flex-col gap-2 shadow-[var(--shadow-2)] outline-none"
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxWidth: `${WIDTH}px` }}
        onClick={() => {
          if (del.armed) del.disarm()
        }}
      >
        <div class="flex items-start gap-1.5">
          <h3 class="min-w-0 flex-1 break-words text-sm font-semibold text-fg-strong">
            {ev.summary || '(no title)'}
          </h3>
          {ev.rrule && (
            <span class="mt-0.5 shrink-0 text-muted" title="Repeats">
              <Icon.refresh size={12} />
            </span>
          )}
          <button type="button" class="btn btn-ghost btn-sm icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon.x size={13} />
          </button>
        </div>

        <p class="flex flex-wrap items-center gap-1.5 text-xs text-fg tabular-nums">
          {timeRangeText(record)}
          {ev.allDay && (
            <span class="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">All-day</span>
          )}
        </p>

        {cal && (
          <p class="flex items-center gap-1.5 text-xs text-muted">
            <span class="chip-dot" style={{ '--chip-color': color }} aria-hidden="true" />
            {cal.name}
          </p>
        )}

        {ev.location && <p class="break-words text-xs text-fg">{ev.location}</p>}
        {ev.description && (
          <p class="line-clamp-4 whitespace-pre-line break-words text-xs text-muted">{ev.description}</p>
        )}

        {tags.length > 0 && (
          <div class="flex flex-wrap gap-1">
            {tags.map((t) => (
              <span key={t} class="tag-chip">{t}</span>
            ))}
          </div>
        )}

        <div class="mt-1 flex items-center gap-2">
          <button type="button" class="btn btn-primary btn-sm flex-1" title="Edit event" onClick={edit}>
            Edit
          </button>
          <button
            type="button"
            class={`btn btn-sm ${del.armed ? 'btn-danger animate-pulse' : 'btn-ghost text-danger'}`}
            title={del.armed ? 'Click again to delete' : 'Delete event'}
            aria-label={del.armed ? 'Click again to delete' : 'Delete event'}
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
