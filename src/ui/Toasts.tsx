/** @jsxImportSource preact */
/**
 * Toast host (design.md §5): bottom-right stack of --surface cards with
 * --shadow-1, kind dots (info --muted / success --success / error --danger),
 * manual close + 3.5s auto-dismiss driven by the expiry stamps from
 * stores/toasts.ts.
 */
import { useEffect } from 'preact/hooks';
import { dismissToast, runToastAction, toasts } from '@wycal/core/stores/toasts';
import { Icon } from './icons';

const DOT_CLASS: Record<string, string> = {
  info: 'bg-muted',
  success: 'bg-success',
  error: 'bg-danger',
};

export function ToastHost() {
  const list = toasts.value;

  // One timer for the soonest expiry; each fire prunes everything already
  // expired (a longer-lived toast schedules the next pass on re-render).
  useEffect(() => {
    if (list.length === 0) return;
    const soonest = Math.min(...list.map((t) => t.expiresAt));
    const id = window.setTimeout(() => {
      const next = toasts.value.filter((t) => t.expiresAt > Date.now());
      if (next.length !== toasts.value.length) toasts.value = next;
    }, Math.max(0, soonest - Date.now()));
    return () => window.clearTimeout(id);
  }, [list]);

  if (list.length === 0) return null;

  return (
    <div class="fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          class="flex max-w-80 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 shadow-[var(--shadow-1)]"
        >
          <span
            class={`size-2 shrink-0 rounded-full ${DOT_CLASS[t.kind] ?? DOT_CLASS.info}`}
            aria-hidden="true"
          />
          <span class="text-sm text-fg-strong">{t.msg}</span>
          {t.action && (
            <button
              type="button"
              class="btn btn-ghost btn-sm ml-1 h-6 shrink-0 px-2"
              aria-label={t.action.label}
              onClick={() => runToastAction(t.id)}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            class="btn btn-ghost btn-sm icon-btn -mr-1 ml-1 h-6 w-6"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(t.id)}
          >
            <Icon.x size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
