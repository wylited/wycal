/** @jsxImportSource preact */
/**
 * Calendar empty state (design.md §5 empty-state rule; CONTRACTS §19): shown
 * when no collections exist and nothing is syncing. With zero configured
 * accounts it offers the one-click local-admin bootstrap; when an account
 * exists but its sync errored (no collections ever arrived) it shows the
 * engine's message with Retry / Open Settings instead.
 */
import { accounts } from '../../stores/accounts'
import { requestSyncAll } from '../../lib/sync/engine'
import { Icon } from '../../ui/icons'
import { ROUTES } from '../../routes'

export function CalendarEmptyState(props: { onConnect: () => void; syncError?: string | null }) {
  if (props.syncError) {
    return (
      <div class="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <Icon.alert size={24} />
        <p class="max-w-sm text-center text-sm">{props.syncError}</p>
        <div class="flex items-center gap-2">
          <button type="button" class="btn btn-primary btn-sm" title="Retry sync" onClick={() => requestSyncAll()}>
            <Icon.refresh size={14} />
            Retry
          </button>
          <a class="btn btn-ghost btn-sm" href={`#${ROUTES.settings}`}>
            Open Settings
          </a>
        </div>
      </div>
    )
  }
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 text-muted">
      <Icon.calendar size={24} />
      <p class="text-sm">No calendars yet</p>
      {accounts.value.length === 0 ? (
        // §19 bootstrap: one click provisions the local Radicale admin account.
        <button type="button" class="btn btn-primary btn-sm" title="Connect local admin (admin/admin)" onClick={props.onConnect}>
          Connect local admin (admin/admin)
        </button>
      ) : (
        <a class="btn btn-primary btn-sm" href={`#${ROUTES.settings}`}>
          Add an account in Settings
        </a>
      )}
    </div>
  )
}
