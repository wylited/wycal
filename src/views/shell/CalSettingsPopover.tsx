/** @jsxImportSource preact */
/**
 * Per-calendar settings popover (CONTRACTS §18): live collection color row
 * (PROPPATCH via calendars.setCollectionColor), per-calendar defaults for
 * new events (stores/caldefaults), and an 'Open tasks' shortcut for
 * VTODO-capable calendars. Closes on outside click and Esc. The collection
 * is resolved live from the store so optimistic color updates show up.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { collectionColor, collections, setCollectionColor } from '../../stores/calendars';
import { getCalDefaults, setCalDefaults } from '../../stores/caldefaults';
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui';
import { Icon } from '../../ui/icons';
import { SwatchRow } from './NewCalendarModal';

const WIDTH = 268;

/** Same option vocabulary as the event editor (CONTRACTS §7/§17). */
const REPEAT_OPTIONS = [
  ['none', 'None'],
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
  ['custom', 'Custom'],
] as const;

const DURATION_OPTIONS = [
  ['15', '15 minutes'],
  ['30', '30 minutes'],
  ['60', '1 hour'],
  ['90', '90 minutes'],
  ['120', '2 hours'],
] as const;

const REMINDER_OPTIONS = [
  ['none', 'None'],
  ['0', 'At time'],
  ['5', '5 min before'],
  ['10', '10 min before'],
  ['30', '30 min before'],
] as const;

interface DefaultsState {
  repeat: string;
  duration: string;
  reminder: string;
  eventColor: string | null;
}

function defaultsOf(url: string): DefaultsState {
  const d = getCalDefaults(url);
  return {
    repeat: d.repeat ?? 'none',
    duration: d.durationMin != null ? String(d.durationMin) : '',
    reminder: d.reminder ?? 'none',
    eventColor: d.eventColor ?? null,
  };
}

const BLANK_DEFAULTS: DefaultsState = { repeat: 'none', duration: '', reminder: 'none', eventColor: null };

export function CalSettingsPopover(props: { calUrl: string; anchor: HTMLElement; onClose: () => void }) {
  // Live lookup: setCollectionColor optimistically replaces the collection.
  const cal = collections.value.find((c) => c.url === props.calUrl);
  const [state, setState] = useState<DefaultsState>(() =>
    cal !== undefined ? defaultsOf(cal.url) : BLANK_DEFAULTS,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos] = useState(() => {
    const rect = props.anchor.getBoundingClientRect();
    const top = Math.min(Math.max(8, rect.bottom + 4), Math.max(8, window.innerHeight - 420));
    const left = Math.min(Math.max(8, rect.right + 8), Math.max(8, window.innerWidth - WIDTH - 8));
    return { top, left, maxHeight: Math.max(180, window.innerHeight - top - 8) };
  });

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    const anchor = props.anchor;
    return () => {
      document.removeEventListener('keydown', onKey);
      anchor.focus();
    };
  }, []);

  // Register with the global dialog gate (stores/ui) while mounted and the
  // collection is resolvable, so global shortcuts (app.tsx §16) are gated.
  const present = cal !== undefined;
  useEffect(() => {
    if (!present) return;
    bumpDialogOpen();
    return bumpDialogClose;
  }, [present]);

  if (cal === undefined) return null; // collection vanished (account removed)

  // Merge patch; `undefined` clears the key in the caldefaults store.
  const patch = (p: Partial<DefaultsState>): void => {
    const next = { ...state, ...p };
    setState(next);
    setCalDefaults(cal.url, {
      repeat: next.repeat,
      durationMin: next.duration === '' ? undefined : Number(next.duration),
      reminder: next.reminder,
      eventColor: next.eventColor ?? undefined,
    });
  };

  const currentColor = cal.color?.trim() ?? '';

  return (
    <>
      <div class="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${cal.name} settings`}
        tabIndex={-1}
        class="card fixed z-50 flex flex-col gap-3 shadow-[var(--shadow-2)] outline-none"
        style={{
          left: `${pos.left}px`,
          top: `${pos.top}px`,
          width: `${WIDTH}px`,
          maxHeight: `${pos.maxHeight}px`,
        }}
      >
        <div class="flex items-center gap-2">
          <span class="chip-dot" style={{ '--chip-color': collectionColor(cal) }} aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg-strong">{cal.name}</span>
          <button type="button" class="btn btn-ghost btn-sm icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon.x size={13} />
          </button>
        </div>

        <div class="flex flex-col gap-1 text-xs text-muted">
          Color
          <SwatchRow
            selected={currentColor === '' ? null : currentColor}
            onPick={(hex) => {
              // Optimistic in the store; failures toast + roll back there.
              if (hex !== null) void setCollectionColor(cal, hex);
            }}
          />
        </div>

        <div class="flex flex-col gap-2 border-t border-border pt-2">
          <span class="text-xs text-muted">Defaults for new events</span>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Repeat
            <select class="input" value={state.repeat} onChange={(e) => patch({ repeat: e.currentTarget.value })}>
              {REPEAT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1 text-xs text-muted">
              Duration
              <select
                class="input"
                value={state.duration}
                onChange={(e) => patch({ duration: e.currentTarget.value })}
              >
                <option value="">Not set</option>
                {DURATION_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Reminder
              <select
                class="input"
                value={state.reminder}
                onChange={(e) => patch({ reminder: e.currentTarget.value })}
              >
                {REMINDER_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="flex flex-col gap-1 text-xs text-muted">
            Event color
            <SwatchRow
              selected={state.eventColor}
              noneLabel="Calendar color"
              onPick={(hex) => patch({ eventColor: hex })}
            />
          </div>
        </div>

        {cal.components.includes('VTODO') && (
          <div class="border-t border-border pt-2">
            <a
              href="#/tasks"
              class="text-sm text-accent hover:underline"
              title="Open tasks (T)"
              onClick={props.onClose}
            >
              Open tasks
            </a>
          </div>
        )}
      </div>
    </>
  );
}
