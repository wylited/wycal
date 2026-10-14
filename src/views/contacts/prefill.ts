// Contact create prefill handoff from the command palette (CONTRACTS §14
// palette → contacts create): a `wycal:newcontact` dispatch races the route
// change to `#/contacts` — ContactsView is not mounted yet and the event is
// lost, so the editor never opens. The palette instead stashes the prefill
// here before navigating; ContactsView consumes it on mount.
import { signal } from '@preact/signals'

export interface ContactPrefill { fn: string; email?: string; tel?: string }

/** Set by the palette; ContactsView consumes on mount (survives route change). */
export const pendingContactPrefill = signal<ContactPrefill | null>(null)

/** One-shot: return the pending prefill and clear it, so a stale value can
 *  never re-open the editor on a later mount. */
export function consumeContactPrefill(): ContactPrefill | null {
  const p = pendingContactPrefill.value
  pendingContactPrefill.value = null
  return p
}
