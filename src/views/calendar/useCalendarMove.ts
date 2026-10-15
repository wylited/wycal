/**
 * Drag-move / resize → optimistic store update (CONTRACTS §5). Recurring
 * series ask for an edit scope first (CalendarView's ScopeModal resolves via
 * `askScope`; null = cancelled → revert). Agenda todo rows (§15) carry no
 * event record, so they revert untouched.
 */
import { useCallback } from 'preact/hooks'
import type { EventDropArg } from '@fullcalendar/core'
import type { EventResizeDoneArg } from '@fullcalendar/interaction'
import { toIcsDateInput } from '@wycal/core/lib/ics/types'
import { updateEvent, type EditScope, type EventPatch, type EventRecord } from '@wycal/core/stores/events'

export function useCalendarMove(askScope: () => Promise<EditScope | null>): {
  onEventDrop: (info: EventDropArg) => void
  onEventResize: (info: EventResizeDoneArg) => void
} {
  const moveEvent = useCallback(
    async (info: EventDropArg | EventResizeDoneArg) => {
      const rec: EventRecord | undefined = info.event.extendedProps.record
      if (!rec || !info.event.start) {
        info.revert()
        return
      }
      const allDay = info.event.allDay
      const end = info.event.end ?? info.event.start
      // UTC-form originals (timed, no TZID, not floating) must stay UTC —
      // defaulting them to floating would shift the event by the zone offset.
      const patch: EventPatch = {
        start: toIcsDateInput(
          info.event.start,
          allDay,
          allDay ? undefined : rec.data.start.tzid,
          !allDay && !rec.data.start.tzid && !rec.data.start.floating && !rec.data.start.date,
        ),
        end: toIcsDateInput(
          end,
          allDay,
          allDay ? undefined : rec.data.end.tzid,
          !allDay && !rec.data.end.tzid && !rec.data.end.floating && !rec.data.end.date,
        ),
        allDay,
      }
      let scope: EditScope | null = 'all'
      if (rec.data.rrule) {
        scope = await askScope()
        if (scope === null) {
          info.revert()
          return
        }
      }
      try {
        // Optimistic; the store rolls itself back + toasts on failure.
        await updateEvent(rec, patch, scope)
      } catch {
        info.revert()
      }
    },
    [askScope],
  )

  const onEventDrop = useCallback((info: EventDropArg) => void moveEvent(info), [moveEvent])
  const onEventResize = useCallback((info: EventResizeDoneArg) => void moveEvent(info), [moveEvent])

  return { onEventDrop, onEventResize }
}
