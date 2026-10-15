/** @jsxImportSource preact */
/**
 * Sidebar mini-month (CONTRACTS §5, design.md §9.1–§9.2): tiny 168px own
 * grid with occurrence dots and square today/selected highlights (.mm-day),
 * plus month/year dropdown navigation (.period-popover, current±10 years)
 * that also drives the main calendar's date via the hash contract.
 * Split out of Sidebar.tsx (§10: files ≤ ~400 lines).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { occurrences } from '@wycal/core/stores/events';
import { prefs } from '@wycal/core/stores/prefs';
import { addDays, dayKey, startOfWeek } from '@wycal/core/lib/util/date';
import { icsDateToDate } from '@wycal/core/lib/ics/types';
import { gotoCalendarQuery } from '../../routes';
import { Icon } from '../../ui/icons';

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Narrow weekday initials ordered Sunday-first (locale-correct). */
const WEEKDAY_INITIALS: string[] = (() => {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i))); // 2023-01-01 was a Sunday
})();

/** Localized month names for the §9.2 picker (Intl — same convention as the grid). */
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i,
  label: new Date(2023, i, 1).toLocaleDateString(undefined, { month: 'long' }),
}));

/** §9.2 dropdown: ghost trigger + .period-popover list; closes on outside click/Esc. */
function PeriodPicker(props: {
  label: string;
  title: string;
  options: { value: number; label: string }[];
  selected: number;
  onSelect: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      // Restore focus to the trigger on every close path (option select,
      // outside click, Esc) so keyboard users aren't stranded on <body>.
      triggerRef.current?.focus();
    };
  }, [open]);
  return (
    <span class="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        class="btn btn-ghost btn-sm font-medium text-fg-strong tabular-nums"
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {props.label}
        <Icon.chevronDown size={12} />
      </button>
      {open && (
        <div class="period-popover" role="listbox" aria-label={props.title}>
          {props.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              class={`period-option${o.value === props.selected ? ' is-active' : ''}`}
              aria-selected={o.value === props.selected}
              onClick={() => {
                props.onSelect(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Tiny 168px month grid: occurrence dots + click-to-navigate (CONTRACTS §5). */
export function MiniMonth(props: { routeDate: string | null }) {
  const [anchor, setAnchor] = useState<Date>(() => {
    const base = props.routeDate ? parseDateKey(props.routeDate) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  // Follow the main view's month when its date param moves.
  useEffect(() => {
    if (!props.routeDate) return;
    const d = parseDateKey(props.routeDate);
    setAnchor((prev) =>
      prev.getFullYear() === d.getFullYear() && prev.getMonth() === d.getMonth()
        ? prev
        : new Date(d.getFullYear(), d.getMonth(), 1),
    );
  }, [props.routeDate]);

  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const nextMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  const firstDay = prefs.value.firstDay;
  const today = dayKey(new Date());
  const selected = props.routeDate;

  // Mark every day spanned by an occurrence (multi-day events light each day).
  const eventDays = new Set<string>();
  for (const rec of occurrences({ start: first.toISOString(), end: nextMonth.toISOString() })) {
    const startMs = Math.max(first.getTime(), icsDateToDate(rec.data.start).getTime());
    const endMs = Math.min(
      nextMonth.getTime(),
      Math.max(icsDateToDate(rec.data.end).getTime(), startMs + 60_000),
    );
    for (let t = startMs; t < endMs; t = new Date(t).setHours(24, 0, 0, 0)) {
      eventDays.add(dayKey(new Date(t)));
    }
  }

  const gridStart = startOfWeek(first, firstDay);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const weekdayCols = [...WEEKDAY_INITIALS.slice(firstDay), ...WEEKDAY_INITIALS.slice(0, firstDay)];

  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 21 }, (_, i) => {
    const y = thisYear - 10 + i;
    return { value: y, label: String(y) };
  });

  // Picker selection navigates the mini-month AND the main view (first of month).
  const gotoMonth = (month: number, year: number): void => {
    const d = new Date(year, month, 1);
    setAnchor(d);
    gotoCalendarQuery({ date: dayKey(d) });
  };

  return (
    <div class="mx-auto w-42">
      <div class="mm-head flex items-center justify-between" title="Drag the sidebar edge to resize">
        <button
          type="button"
          class="btn btn-ghost btn-sm icon-btn mm-nav"
          aria-label="Previous month"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
        >
          <Icon.chevronLeft size={14} />
        </button>
        <div class="flex items-center gap-0.5">
          <PeriodPicker
            label={first.toLocaleDateString(undefined, { month: 'short' })}
            title="Choose month"
            options={MONTH_OPTIONS}
            selected={first.getMonth()}
            onSelect={(month) => gotoMonth(month, first.getFullYear())}
          />
          <PeriodPicker
            label={String(first.getFullYear())}
            title="Choose year"
            options={years}
            selected={first.getFullYear()}
            onSelect={(year) => gotoMonth(first.getMonth(), year)}
          />
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm icon-btn mm-nav"
          aria-label="Next month"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
        >
          <Icon.chevronRight size={14} />
        </button>
      </div>
      <div class="mt-1 grid grid-cols-7" aria-hidden="true">
        {weekdayCols.map((w, i) => (
          <span key={i} class="mm-weekday text-center text-xs text-muted">
            {w}
          </span>
        ))}
      </div>
      <div class="grid grid-cols-7">
        {cells.map((d) => {
          const key = dayKey(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = key === today;
          const isSelected = key === selected;
          return (
            // §9.1: squares — today = filled accent, selected = 1.5px inset
            // ring, both = filled + inner ring; .mm-day owns the geometry.
            <button
              key={key}
              type="button"
              class={`mm-day relative${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''} ${
                inMonth ? 'text-fg' : 'text-muted/60'
              }`}
              aria-label={d.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => gotoCalendarQuery({ date: key })}
            >
              {d.getDate()}
              {eventDays.has(key) && (
                <span class="absolute bottom-0.5 size-1 rounded-full bg-accent" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
