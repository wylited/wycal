/** @jsxImportSource preact */
/**
 * Recurring-edit scope chooser (CONTRACTS §7): raised when a drag-move/resize
 * touches a member of a repeating series; resolves 'this' | 'future' | 'all',
 * or null on cancel (the caller reverts the gesture).
 */
import { Modal } from '../../ui/Modal'
import type { EditScope } from '../../stores/events'

export function ScopeModal(props: { open: boolean; onResolve: (scope: EditScope | null) => void }) {
  return (
    <Modal
      open={props.open}
      title="Repeating event"
      onClose={() => props.onResolve(null)}
      width={400}
      footer={
        /* Wrap, don't crowd: buttons that don't fit drop to a right-aligned
           second row instead of pushing 'All events' against/off the card edge
           (the shared Modal caps width at min(400px, calc(100vw - 32px))). */
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="button" class="btn btn-ghost" onClick={() => props.onResolve(null)}>Cancel</button>
          <button type="button" class="btn" onClick={() => props.onResolve('this')}>This event</button>
          <button type="button" class="btn" onClick={() => props.onResolve('future')}>This and following</button>
          <button type="button" class="btn btn-primary" onClick={() => props.onResolve('all')}>All events</button>
        </div>
      }
    >
      <p class="text-base">This event repeats. Which occurrences should change?</p>
    </Modal>
  )
}
