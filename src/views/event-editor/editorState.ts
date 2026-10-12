/**
 * Event editor open/close state (CONTRACTS §7).
 *
 * CalendarView/Shell call `openEditor()` (drag-select, date click, event
 * click, "New" button) and mount a single `<EventEditor/>`, which renders
 * from the `editor` signal. Esc/scrim/Cancel discard via `closeEditor()`.
 */
import { signal } from '@preact/signals'
import type { EventRecord } from '../../stores/events'

/** What the editor was opened for. */
export type EditorRequest =
  | {
      mode: 'create'
      calendarUrl?: string
      startUtc: string
      endUtc?: string
      allDay: boolean
    }
  | { mode: 'edit'; record: EventRecord }

/** Current editor request, or null when the editor is closed. */
export const editor = signal<EditorRequest | null>(null)

/** Open the event editor (replaces any open editor). */
export function openEditor(req: EditorRequest): void {
  editor.value = req
}

/** Close the editor, discarding any unsaved changes. */
export function closeEditor(): void {
  editor.value = null
}
