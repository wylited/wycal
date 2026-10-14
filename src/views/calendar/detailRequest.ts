/**
 * Palette → detail-popover bridge (wave 16): the command palette navigates
 * with gotoCalendarQuery and then raises one of these; CalendarView consumes
 * the signal in an effect, resolves the record from the events/todos stores
 * (uid + calendarUrl) and opens the matching Event/TodoDetailPopover anchored
 * to the occurrence's DOM element (uid→el map kept from FullCalendar
 * eventDidMount / agenda row mounts; geometry fallback when not rendered).
 *
 * todoEditor.ts signal pattern: module-level signal, no wiring at callsites.
 */
import { signal } from '@preact/signals'

export interface DetailRequest {
  kind: 'event' | 'todo'
  uid: string
  calendarUrl: string
}

export const detailRequest = signal<DetailRequest | null>(null)

/** Ask CalendarView to open the detail popover for this record. */
export function requestDetail(r: DetailRequest): void {
  detailRequest.value = r
}

/** Read-and-clear (the consuming effect owns the request once read). */
export function consumeDetail(): DetailRequest | null {
  const v = detailRequest.value
  detailRequest.value = null
  return v
}
