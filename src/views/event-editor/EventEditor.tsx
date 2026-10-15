/** @jsxImportSource preact */
/**
 * Event editor modal (CONTRACTS §7, design.md §5), rendered from the
 * `editor` signal (./editorState). Title, calendar (visible collections +
 * color dot), all-day toggle (date+time inputs ↔ date-only), start/end, location,
 * notes, repeat (presets / custom interval+BYDAY → raw RRULE), reminder
 * (→ VALARM trigger), event color (PALETTE swatches → X-WYCAL-COLOR) and
 * comma-separated tags (→ CATEGORIES). Series edits show a scope segmented
 * used for Save and Delete. Per-calendar defaults (stores/caldefaults) prefill
 * repeat/duration/reminder/eventColor on create and on calendar change while
 * the fields are untouched; a calendar named 'Birthdays' additionally
 * defaults all-day + repeat Yearly. Closes only on store success — the store
 * toasts and rolls back failures itself, so the editor stays open on error.
 * Contract simplifications: Custom repeat is weekly-based; rules outside the
 * preset vocabulary display as Custom and round-trip verbatim while Repeat is
 * untouched; reminders outside -PT{0,5,10,30}M display as None and are kept
 * verbatim while Reminder is untouched; tag lists round-trip verbatim while
 * the Tags input is untouched. Dialog keybinds (CONTRACTS §16):
 * Cmd/Ctrl+Enter save · Cmd/Ctrl+Shift+Backspace delete (arms; second press
 * confirms, any other key disarms — CONTRACTS §21) · Esc cancel.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { Modal } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { createEvent, deleteEvent, overrides, restoreEvent, updateEvent } from '@wycal/core/stores/events'
import type { EditScope, EventDeleteUndo } from '@wycal/core/stores/events'
import { collectionColor, collections, visibleCollections } from '@wycal/core/stores/calendars'
import { getCalDefaults } from '@wycal/core/stores/caldefaults'
import { prefs } from '@wycal/core/stores/prefs'
import { push } from '@wycal/core/stores/toasts'
import { PALETTE, eventColorFor } from '@wycal/core/lib/util/colors'
import { newUid } from '@wycal/core/lib/util/id'
import { addDays, addMinutes } from '@wycal/core/lib/util/date'
import { serializeIcsEvent } from '@wycal/core/lib/ics/serialize'
import { WEEKDAYS, buildRepeat, parseRepeat, weekdayCode } from '@wycal/core/lib/ics/recurrence'
import type { RepeatPreset, RepeatState } from '@wycal/core/lib/ics/recurrence'
import { icsDateToDate, localDateStr, localMidnight, pad2, toIcsDateInput } from '@wycal/core/lib/ics/types'
import type { DavCollection } from '@wycal/core/lib/caldav/types'
import { closeEditor, editor } from './editorState'
import type { EditorRequest } from './editorState'

const REPEAT_OPTIONS = [
  ['none', 'None'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'],
  ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['custom', 'Custom'],
] as const

const REMINDER_OPTIONS = [
  ['none', 'None'], ['0', 'At time'], ['5', '5 min before'], ['10', '10 min before'], ['30', '30 min before'],
] as const

const SCOPE_OPTIONS: { value: EditScope; label: string }[] = [
  { value: 'this', label: 'This event' }, { value: 'future', label: 'This and following' }, { value: 'all', label: 'All events' },
]

/** Dialog keybind labels (CONTRACTS §16) — shown in every button title. */
const SAVE_KBD = 'Cmd/Ctrl+Enter'
const DELETE_KBD = 'Cmd/Ctrl+Shift+Backspace'
const CANCEL_KBD = 'Esc'
// --- Local input plumbing (IcsDate ↔ date / time input strings) ------------
// Start/end use SEPARATE native date + time inputs (Google pattern; the
// datetime-local they replaced truncated its AM/PM under the picker icon).

/** Date → native time input value: `HH:MM` local. */
function toTimeInputValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Native date input value → local midnight, or null when incomplete. */
function parseDateInput(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = localMidnight(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Native date + time input values → local Date, or null when incomplete. */
function parseDateTimeInput(date: string, time: string): Date | null {
  const d = parseDateInput(date)
  const m = /^(\d{2}):(\d{2})$/.exec(time)
  if (d === null || m === null) return null
  d.setHours(Number(m[1]), Number(m[2]))
  return d
}

/**
 * Two-step delete confirm (CONTRACTS §21): the first `activate` arms — the
 * Delete button turns into danger 'Sure?' — the second deletes; a 3s timer
 * reverts. `disarm` runs for any other key so the Cmd/Ctrl+Shift+Backspace
 * keybind shares the same steps (first press arms, second confirms).
 * File-local to the views owning delete affordances.
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

/** First VALARM trigger → select value; unknown triggers normalize to None. */
function reminderValue(alarms: { trigger: string }[]): string {
  const m = /^-PT(\d+)M$/.exec(alarms[0]?.trigger ?? '')
  const min = m ? Number(m[1]) : NaN
  return min === 0 || min === 5 || min === 10 || min === 30 ? String(min) : 'none'
}

// --- Tags (CATEGORIES) + per-calendar defaults (CONTRACTS §12/§17) ---------

/** Comma-separated input → CATEGORIES list; blanks dropped, values trimmed. */
function parseTags(input: string): string[] {
  return input.split(',').map((t) => t.trim()).filter((t) => t !== '')
}

/** caldefaults `repeat` preset id → initial RepeatState; unknown ids → None. */
function defaultsRepeatState(preset: string | undefined, start: Date): RepeatState {
  if (preset !== undefined && REPEAT_OPTIONS.some(([v]) => v === preset)) {
    return { preset: preset as RepeatPreset, interval: 1, byDay: [weekdayCode(start)] }
  }
  return { preset: 'none', interval: 1, byDay: [weekdayCode(start)] }
}

/** caldefaults `reminder` select value; unknown ids → None. */
function coerceReminderValue(value: string | undefined): string {
  return value !== undefined && REMINDER_OPTIONS.some(([v]) => v === value) ? value : 'none'
}

/**
 * Selectable calendars: visible VEVENT collections; when editing an event on
 * a now-hidden calendar, keep it selectable at the top.
 */
function calendarOptions(current?: string): DavCollection[] {
  const list = visibleCollections.value.filter((c) => c.kind === 'calendar' && c.components.includes('VEVENT'))
  if (current && !list.some((c) => c.url === current)) {
    const extra = collections.value.find((c) => c.url === current)
    if (extra) return [extra, ...list]
  }
  return list
}

/**
 * The end paired with a start: default duration past it (+1 day for all-day,
 * where DTEND is exclusive). One formula shared by the initial end and the
 * CONTRACTS §7 auto-bump when a change leaves end ≤ start.
 */
function bumpEnd(start: Date, allDay: boolean): Date {
  return allDay ? addDays(start, 1) : addMinutes(start, prefs.value.defaultDurationMin)
}

/**
 * Fresh form state per editor open (EventForm remounts via key). Create
 * prefills repeat/duration/reminder/eventColor from the selected calendar's
 * caldefaults (CONTRACTS §17); a calendar named 'Birthdays' additionally
 * defaults all-day + repeat Yearly.
 */
function initialForm(req: EditorRequest) {
  const wanted = req.mode === 'edit' ? req.record.calendarUrl : req.calendarUrl
  const opts = calendarOptions(wanted)
  const calUrl = wanted !== undefined && opts.some((c) => c.url === wanted) ? wanted : (opts[0]?.url ?? '')
  if (req.mode === 'create') {
    const start = new Date(req.startUtc)
    const birthday = calUrl !== '' && opts.find((c) => c.url === calUrl)?.name === 'Birthdays'
    const defs = getCalDefaults(calUrl)
    const allDay = birthday || req.allDay
    // A drag-provided endUtc (user drew the span) beats the duration default.
    const end =
      req.endUtc !== undefined
        ? new Date(req.endUtc)
        : allDay
          ? addDays(start, 1)
          : addMinutes(start, defs?.durationMin ?? prefs.value.defaultDurationMin)
    // All-day DTEND is exclusive: a same-date end would be zero-length.
    const endFixed = allDay && localDateStr(end) === localDateStr(start) ? addDays(start, 1) : end
    return {
      calUrl, allDay,
      startDate: localDateStr(start), startTime: allDay ? '' : toTimeInputValue(start),
      endDate: localDateStr(endFixed), endTime: allDay ? '' : toTimeInputValue(endFixed),
      title: '', location: '', notes: '', tags: '',
      repeat: birthday
        ? { preset: 'yearly' as RepeatPreset, interval: 1, byDay: [weekdayCode(start)] }
        : defaultsRepeatState(defs?.repeat, start),
      reminder: coerceReminderValue(defs?.reminder),
      eventColor: defs?.eventColor,
    }
  }
  const d = req.record.data
  const start = icsDateToDate(d.start)
  const end = icsDateToDate(d.end)
  return {
    calUrl, allDay: d.allDay,
    startDate: localDateStr(start), startTime: d.allDay ? '' : toTimeInputValue(start),
    endDate: localDateStr(end), endTime: d.allDay ? '' : toTimeInputValue(end),
    title: d.summary, location: d.location ?? '', notes: d.description ?? '',
    tags: (d.categories ?? []).join(', '),
    repeat: parseRepeat(d.rrule, start), reminder: reminderValue(d.alarms),
    eventColor: d.color,
  }
}
// --- Components -------------------------------------------------------------

/** Labelled row: `--text-xs --muted` 500 label 4px above the control. */
function Field(props: { label: string; children: ComponentChildren }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{props.label}</span>
      {props.children}
    </label>
  )
}

/** Custom repeat reveal: interval number + BYDAY weekday toggles. */
function CustomRepeatRow(props: { repeat: RepeatState; onChange: (next: RepeatState) => void }) {
  const { repeat, onChange } = props
  return (
    <div class="flex flex-wrap items-center gap-2 pt-1">
      <span class="flex items-center gap-1 text-sm text-fg">
        Every
        <input
          type="number" min={1} step={1} class="input w-16 tabular-nums" value={repeat.interval}
          onChange={(e) => {
            const n = Number(e.currentTarget.value)
            onChange({ ...repeat, interval: Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1 })
          }}
        />
        week(s) on
      </span>
      <div class="flex gap-1">
        {WEEKDAYS.map((w) => (
          <button
            key={w.code} type="button" title={w.name} aria-pressed={repeat.byDay.includes(w.code)}
            class={`btn btn-sm w-7 p-0 ${repeat.byDay.includes(w.code) ? 'day-toggle' : ''}`}
            onClick={() =>
              onChange({
                ...repeat,
                byDay: repeat.byDay.includes(w.code) ? repeat.byDay.filter((d) => d !== w.code) : [...repeat.byDay, w.code],
              })
            }
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Event color row (CONTRACTS §17, design.md §9.3): 20px PALETTE swatches —
 * `.swatch` chrome from styles/app.css (reads `--chip-color`), selected adds
 * `.swatch-selected` (ring + CSS check). The leading `.swatch-none` slash
 * chip clears back to the effective calendar-side color (no X-WYCAL-COLOR).
 */
function ColorRow(props: {
  effectiveColor: string | undefined
  value: string | undefined
  onSelect: (hex: string | undefined) => void
}) {
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      <button
        type="button" aria-label="Use calendar color" aria-pressed={props.value === undefined}
        title={`Use calendar color${props.effectiveColor !== undefined ? ` (${props.effectiveColor})` : ''}`}
        class={`swatch swatch-none${props.value === undefined ? ' swatch-selected' : ''}`}
        onClick={() => props.onSelect(undefined)}
      />
      {PALETTE.map((c) => (
        <button
          key={c.hex} type="button" title={c.name} aria-pressed={props.value === c.hex}
          class={`swatch${props.value === c.hex ? ' swatch-selected' : ''}`}
          style={{ '--chip-color': c.hex }}
          onClick={() => props.onSelect(c.hex)}
        />
      ))}
    </div>
  )
}

/** Mounted once; renders the editor modal from the `editor` signal. */
export function EventEditor() {
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    if (editor.value !== null) setSeq((n) => n + 1)
  }, [editor.value])
  const req = editor.value
  if (!req) return null
  return <EventForm key={seq} request={req} />
}

function EventForm({ request }: { request: EditorRequest }) {
  const [init] = useState(() => initialForm(request))
  const [calUrl, setCalUrl] = useState(init.calUrl)
  const [allDay, setAllDay] = useState(init.allDay)
  const [startDate, setStartDate] = useState(init.startDate)
  const [startTime, setStartTime] = useState(init.startTime)
  const [endDate, setEndDate] = useState(init.endDate)
  const [endTime, setEndTime] = useState(init.endTime)
  const [title, setTitle] = useState(init.title)
  const [location, setLocation] = useState(init.location)
  const [notes, setNotes] = useState(init.notes)
  const [tags, setTags] = useState(init.tags)
  const [repeat, setRepeat] = useState<RepeatState>(init.repeat)
  const [reminder, setReminder] = useState(init.reminder)
  const [eventColor, setEventColor] = useState<string | undefined>(init.eventColor)
  // Set only when a control is touched by the user; an untouched edit-mode
  // rule/alarm set round-trips verbatim instead of being rebuilt through the
  // preset vocabulary, and untouched repeat/duration/reminder/color fields
  // follow caldefaults when the calendar changes (CONTRACTS §17).
  const [dirtyRepeat, setDirtyRepeat] = useState(false)
  const [dirtyReminder, setDirtyReminder] = useState(false)
  const [dirtyDuration, setDirtyDuration] = useState(false)
  const [dirtyColor, setDirtyColor] = useState(false)
  const [dirtyTags, setDirtyTags] = useState(false)
  const [dirtyAllDay, setDirtyAllDay] = useState(false)
  const [scope, setScope] = useState<EditScope>('all')
  const [titleError, setTitleError] = useState(false)
  const [rangeInvalid, setRangeInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  // Two-step delete confirm (CONTRACTS §21): button and keybind share it.
  const del = useConfirmDelete(remove)

  const opts = calendarOptions(request.mode === 'edit' ? request.record.calendarUrl : request.calendarUrl)
  const noCalendars = opts.length === 0
  const cal = collections.value.find((c) => c.url === calUrl)
  const calColor = cal !== undefined ? collectionColor(cal) : undefined
  // Color the none-slot reverts to: event.color → caldefaults.eventColor →
  // collection color (CONTRACTS §14 resolution, via util/colors).
  const effectiveColor = calUrl !== '' ? eventColorFor({ color: eventColor, calendarUrl: calUrl }) : undefined
  const isRecurringEdit = request.mode === 'edit' && request.record.data.rrule !== undefined
  const startTz = request.mode === 'edit' ? request.record.data.start.tzid : undefined
  const endTz = request.mode === 'edit' ? request.record.data.end.tzid : undefined
  // UTC-form originals (timed, no TZID, not floating) must stay UTC on edit —
  // defaulting them to floating would shift the event by the zone offset.
  const startUtcForm =
    request.mode === 'edit' && !request.record.data.start.tzid && !request.record.data.start.floating && !request.record.data.start.date
  const endUtcForm =
    request.mode === 'edit' && !request.record.data.end.tzid && !request.record.data.end.floating && !request.record.data.end.date

  /** Current end fields → Date under the active mode (null when incomplete). */
  function parseEnd(): Date | null {
    return allDay ? parseDateInput(endDate) : parseDateTimeInput(endDate, endTime)
  }

  /**
   * CONTRACTS §7 auto-bump: a start change that leaves end ≤ start bumps the
   * end to the paired default (+1 day all-day, default duration timed).
   */
  function autoBumpEnd(s: Date) {
    const e = parseEnd()
    if (e !== null && e.getTime() <= s.getTime()) {
      const next = bumpEnd(s, allDay)
      setEndDate(localDateStr(next))
      setEndTime(toTimeInputValue(next))
      setRangeInvalid(false)
    }
  }

  /** Start date moved: auto-bump a violated end (CONTRACTS §7 validation). */
  function onStartDateChange(v: string) {
    setStartDate(v)
    setDirtyDuration(true)
    const s = allDay ? parseDateInput(v) : parseDateTimeInput(v, startTime)
    if (s !== null) autoBumpEnd(s)
  }

  /** Start time moved (timed only): auto-bump a violated end. */
  function onStartTimeChange(v: string) {
    setStartTime(v)
    setDirtyDuration(true)
    const s = parseDateTimeInput(startDate, v)
    if (s !== null) autoBumpEnd(s)
  }

  /** End edited by hand: flag violations, never auto-bump the value. */
  function onEndDateChange(v: string) {
    setEndDate(v)
    setDirtyDuration(true)
    const s = allDay ? parseDateInput(startDate) : parseDateTimeInput(startDate, startTime)
    const e = allDay ? parseDateInput(v) : parseDateTimeInput(v, endTime)
    setRangeInvalid(s !== null && e !== null && e.getTime() <= s.getTime())
  }

  /** End time edited by hand (timed only): flag violations. */
  function onEndTimeChange(v: string) {
    setEndTime(v)
    setDirtyDuration(true)
    const s = parseDateTimeInput(startDate, startTime)
    const e = parseDateTimeInput(endDate, v)
    setRangeInvalid(s !== null && e !== null && e.getTime() <= s.getTime())
  }

  /**
   * All-day toggle: shows/hides the time inputs and converts the range once —
   * no in-place input-type flipping. Switching to all-day, a range that
   * collapses to a single date gets the +1 day DTEND (exclusive). Switching
   * back to timed, fields that never had a time (created all-day) resume at
   * 00:00 — the old datetime-local round-trip behavior — and a non-positive
   * range gets the default duration. `markDirty` is false when the Birthdays
   * default applies the toggle.
   */
  function applyAllDay(next: boolean, markDirty: boolean) {
    if (markDirty) setDirtyAllDay(true)
    setAllDay(next)
    setRangeInvalid(false)
    if (next) {
      // All-day: DTEND is exclusive — end on/before the start date gets +1 day.
      const s = parseDateInput(startDate)
      const e = parseDateInput(endDate)
      if (s !== null && e !== null && e.getTime() <= s.getTime()) {
        setEndDate(localDateStr(addDays(s, 1)))
      }
      return
    }
    const startT = startTime === '' ? '00:00' : startTime
    const endT = endTime === '' ? '00:00' : endTime
    setStartTime(startT)
    setEndTime(endT)
    const s = parseDateTimeInput(startDate, startT)
    const e = parseDateTimeInput(endDate, endT)
    if (s !== null && e !== null && e.getTime() <= s.getTime()) {
      const endNext = bumpEnd(s, false)
      setEndDate(localDateStr(endNext))
      setEndTime(toTimeInputValue(endNext))
    }
  }

  /**
   * Calendar switched: untouched repeat/duration/reminder/eventColor re-prefill
   * from caldefaults; Birthdays additionally defaults all-day + Yearly
   * (CONTRACTS §17). Edit mode keeps the event's own values authoritative.
   */
  function onCalChange(next: string) {
    setCalUrl(next)
    if (request.mode !== 'create') return
    const defs = getCalDefaults(next)
    const birthday = collections.value.find((c) => c.url === next)?.name === 'Birthdays'
    const s = (allDay ? parseDateInput(startDate) : parseDateTimeInput(startDate, startTime)) ?? new Date()
    if (!dirtyRepeat) {
      setRepeat(
        birthday
          ? { preset: 'yearly', interval: 1, byDay: [weekdayCode(s)] }
          : defaultsRepeatState(defs?.repeat, s),
      )
    }
    if (!dirtyReminder) setReminder(coerceReminderValue(defs?.reminder))
    if (!dirtyColor) setEventColor(defs?.eventColor)
    if (birthday) {
      if (!dirtyAllDay) applyAllDay(true, false)
    } else if (!dirtyDuration) {
      // All-day spans keep the +1 day DTEND; durationMin is a timed concept.
      const endNext = allDay ? addDays(s, 1) : addMinutes(s, defs?.durationMin ?? prefs.value.defaultDurationMin)
      setEndDate(localDateStr(endNext))
      setEndTime(toTimeInputValue(endNext))
    }
  }

  async function save() {
    const s = allDay ? parseDateInput(startDate) : parseDateTimeInput(startDate, startTime)
    const e = parseEnd()
    const summary = title.trim()
    const invalid = s === null || e === null || e.getTime() <= s.getTime()
    setTitleError(summary === '')
    setRangeInvalid(invalid)
    if (summary === '' || s === null || e === null || invalid || calUrl === '') return
    const patch = {
      summary,
      location: location.trim() || undefined, description: notes.trim() || undefined,
      start: toIcsDateInput(s, allDay, startTz, startUtcForm), end: toIcsDateInput(e, allDay, endTz, endUtcForm),
      allDay,
      rrule:
        request.mode === 'edit' && !dirtyRepeat
          ? request.record.data.rrule
          : buildRepeat(repeat, s),
      alarms:
        request.mode === 'edit' && !dirtyReminder
          ? request.record.data.alarms
          : reminder === 'none'
            ? []
            : [{ trigger: `-PT${reminder}M` }],
      // X-WYCAL-COLOR: undefined = no override (calendar color / caldefaults).
      color: eventColor,
      categories:
        request.mode === 'edit' && !dirtyTags ? request.record.data.categories : parseTags(tags),
    }
    setSaving(true)
    try {
      if (request.mode === 'edit') {
        await updateEvent(request.record, patch, request.record.data.rrule ? scope : 'all')
      } else {
        await createEvent(calUrl, { uid: newUid(), ...patch, exdates: [], attendees: [] })
      }
      closeEditor()
    } catch {
      // Store rolled back + toasted (CONTRACTS §4); keep the editor open.
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (request.mode !== 'edit') return
    setSaving(true)
    // Undo (design §5): only a plain, standalone VEVENT delete is restorable
    // by re-PUTting the captured body (restoreEvent); series/occurrence
    // deletes rewrite or remove several objects → plain toast, no action.
    const rec = request.record
    const plainDelete =
      !rec.data.rrule &&
      !rec.data.recurrenceId &&
      ![...overrides.value.values()].some((r) => r.calendarUrl === rec.calendarUrl && r.data.uid === rec.data.uid)
    const undo: EventDeleteUndo | null = plainDelete
      ? {
          calendarUrl: rec.calendarUrl,
          uid: rec.data.uid,
          href: rec.href,
          body: serializeIcsEvent(rec.data),
          data: rec.data,
        }
      : null
    try {
      await deleteEvent(request.record, request.record.data.rrule ? scope : 'all')
      if (undo) push('info', 'Event deleted', { label: 'Undo', run: () => restoreEvent(undo) })
      else push('info', 'Series deleted')
      closeEditor()
    } catch {
      // Store rolled back + toasted; keep the editor open.
    } finally {
      setSaving(false)
    }
  }

  /**
   * Dialog keybinds (CONTRACTS §16), attached at the modal root so they fire
   * from any focused control; propagation stopped so app-level global
   * shortcuts never double-fire while the dialog is open. Esc cancel itself
   * is Modal's focus-trap job (document capture) — here the event is only
   * kept from reaching other handlers.
   */
  function onDialogKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter' && !e.shiftKey) {
      del.disarm()
      e.preventDefault()
      e.stopPropagation()
      if (!saving) void save()
    } else if (mod && e.shiftKey && e.key === 'Backspace' && request.mode === 'edit') {
      e.preventDefault()
      e.stopPropagation()
      // Two-step (CONTRACTS §21): first press arms, second confirms.
      if (!saving) del.activate()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      del.disarm()
    } else {
      // Any other key disarms the delete confirm.
      del.disarm()
    }
  }

  return (
    <div onKeyDown={onDialogKeyDown}>
      <Modal
        open title={request.mode === 'edit' ? 'Edit event' : 'New event'} width={480} onClose={closeEditor}
        footer={
          <>
            {request.mode === 'edit' && (
              <button
                type="button"
                class={`mr-auto ${del.armed ? 'btn btn-danger' : 'btn btn-ghost text-danger'}`}
                title={del.armed ? 'Click again to delete' : `Delete (${DELETE_KBD})`}
                disabled={saving} onClick={del.activate}
              >
                {del.armed ? 'Sure?' : 'Delete'}
              </button>
            )}
            <button type="button" class="btn btn-ghost" title={`Cancel (${CANCEL_KBD})`} onClick={closeEditor}>Cancel</button>
            <button
              type="button" class="btn btn-primary" title={`Save (${SAVE_KBD})`}
              disabled={saving || noCalendars} onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
      <div class="editor-form flex flex-col gap-2">
        <Field label="Title">
          <input
            class="input" value={title} autoFocus aria-required="true" aria-invalid={titleError || undefined}
            onInput={(e) => { setTitle(e.currentTarget.value); if (titleError) setTitleError(false) }}
          />
          {titleError && <span class="text-xs text-danger" role="alert">Title is required.</span>}
        </Field>
        <Field label="Calendar">
          <div class="relative">
            {calColor && <span class="chip-dot pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" style={{ background: calColor }} />}
            <select class={`input ${calColor ? 'pl-7' : ''}`} value={calUrl} onChange={(e) => onCalChange(e.currentTarget.value)}>
              {opts.map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}
            </select>
          </div>
          {noCalendars && (
            <span class="text-xs text-danger" role="alert">Add a calendar in Settings first</span>
          )}
        </Field>
        <label class="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" class="accent-accent" checked={allDay} onChange={(e) => applyAllDay(e.currentTarget.checked, true)} />
          All-day
        </label>
        <div class="flex flex-col gap-2">
          <Field label="Starts">
            <div class="editor-when">
              <input
                type="date" class="input min-w-0 flex-auto tabular-nums" value={startDate}
                onChange={(e) => onStartDateChange(e.currentTarget.value)}
              />
              {!allDay && (
                <input
                  type="time" class="input tabular-nums" value={startTime}
                  onChange={(e) => onStartTimeChange(e.currentTarget.value)}
                />
              )}
            </div>
          </Field>
          <Field label="Ends">
            <div class="editor-when">
              <input
                type="date" class="input min-w-0 flex-auto tabular-nums" value={endDate}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => onEndDateChange(e.currentTarget.value)}
              />
              {!allDay && (
                <input
                  type="time" class="input tabular-nums" value={endTime}
                  onChange={(e) => onEndTimeChange(e.currentTarget.value)}
                />
              )}
            </div>
            {rangeInvalid && <span class="text-xs text-danger" role="alert">End must be after start.</span>}
          </Field>
        </div>
        <Field label="Location">
          <input class="input" value={location} onInput={(e) => setLocation(e.currentTarget.value)} />
        </Field>
        <Field label="Notes">
          <textarea class="input resize-y" rows={3} value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
        </Field>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted">Repeat</span>
          <select
            class="input"
            value={repeat.preset}
            onChange={(e) => {
              setDirtyRepeat(true)
              setRepeat({ ...repeat, preset: e.currentTarget.value as RepeatPreset })
            }}
          >
            {REPEAT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {repeat.preset === 'custom' && (
            <CustomRepeatRow
              repeat={repeat}
              onChange={(next) => {
                setDirtyRepeat(true)
                setRepeat(next)
              }}
            />
          )}
        </div>
        <Field label="Reminder">
          <select
            class="input"
            value={reminder}
            onChange={(e) => {
              setDirtyReminder(true)
              setReminder(e.currentTarget.value)
            }}
          >
            {REMINDER_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        {!noCalendars && (
          <Field label="Color">
            <ColorRow
              effectiveColor={effectiveColor}
              value={eventColor}
              onSelect={(hex) => {
                setDirtyColor(true)
                setEventColor(hex)
              }}
            />
          </Field>
        )}
        <Field label="Tags">
          <input
            class="input w-full min-w-0" value={tags} placeholder="comma-separated, e.g. work, travel"
            onInput={(e) => { setDirtyTags(true); setTags(e.currentTarget.value) }}
          />
          {parseTags(tags).length > 0 && (
            <div class="flex flex-wrap gap-1">
              {parseTags(tags).map((t, i) => (
                <span key={`${t}-${i}`} class="tag-chip">{t}</span>
              ))}
            </div>
          )}
        </Field>
        {isRecurringEdit && (
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Applies to</span>
            <Segmented value={scope} options={SCOPE_OPTIONS} onChange={setScope} ariaLabel="Applies to" />
          </div>
        )}
        </div>
      </Modal>
    </div>
  )
}
