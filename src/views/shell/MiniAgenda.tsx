/** @jsxImportSource preact */
/**
 * Sidebar mini agenda: the next 14 days of occurrences + open todos as
 * compact rows ("Mon 13 · 09:30 Team standup"; all-day rows show "All-day").
 * "Today" leads the day headers (design.md §9.4 day-heading style); a row
 * click navigates the main calendar to that day (hash contract, same as
 * MiniMonth). §5 skeletons while the first sync runs; empty → "Nothing
 * coming up". The ~200px body scrolls with the global themed scrollbar.
 */
import type { IcsDate } from '../../lib/ics/types';
import { icsDateToDate } from '../../lib/ics/types';
import { syncState } from '../../lib/sync/engine';
import { addDays, dayKey, fmtTime } from '../../lib/util/date';
import { occurrences, revision as eventRevision } from '../../stores/events';
import { prefs } from '../../stores/prefs';
import { isTodoDone, revision as todoRevision, todos } from '../../stores/todos';
import { gotoCalendarQuery } from '../../routes';

interface MiniRow {
  time: string;
  title: string;
}

interface MiniDay {
  key: string;
  label: string;
  rows: MiniRow[];
}

/** Local day of an IcsDate: all-day DATE values are already a day key. */
function icsDayKey(d: IcsDate): string {
  return d.date ?? dayKey(icsDateToDate(d));
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Sidebar "Upcoming" section: next 14 days, events then open todos per day. */
export function MiniAgenda() {
  // Signal reads during render keep the subscription live: occurrence
  // buckets (base/overrides/visibility) + both stores' revision bumps +
  // the hour12 pref.
  const hour12 = prefs.value.hour12;
  void eventRevision.value;
  void todoRevision.value;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dayKey(today);
  const endKey = dayKey(addDays(today, 14));

  const rows = new Map<string, MiniRow[]>();
  const add = (key: string, row: MiniRow): void => {
    let list = rows.get(key);
    if (!list) {
      list = [];
      rows.set(key, list);
    }
    list.push(row);
  };

  for (const rec of occurrences({ start: today.toISOString(), end: addDays(today, 14).toISOString() })) {
    // A multi-day event begun before the window still shows under today.
    const startKey = icsDayKey(rec.data.start);
    const key = startKey < todayKey ? todayKey : startKey;
    if (key >= endKey) continue;
    const allDay = rec.data.start.date != null;
    add(key, {
      time: allDay ? 'All-day' : fmtTime(icsDateToDate(rec.data.start), hour12),
      title: rec.data.summary,
    });
  }
  for (const rec of todos.value.values()) {
    if (isTodoDone(rec.data)) continue;
    const when = rec.data.due ?? rec.data.dtstart;
    if (!when) continue;
    const key = icsDayKey(when);
    if (key < todayKey || key >= endKey) continue;
    const allDay = when.date != null;
    add(key, {
      time: allDay ? 'All-day' : fmtTime(icsDateToDate(when), hour12),
      title: `▢ ${rec.data.summary}`,
    });
  }

  const days: MiniDay[] = [...rows.keys()].sort().map((key) => {
    const d = parseDateKey(key);
    return {
      key,
      label:
        key === todayKey
          ? 'Today'
          : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`,
      rows: rows.get(key)!,
    };
  });

  const syncing = [...syncState.value.values()].some((s) => s.state === 'syncing');

  return (
    <section class="border-t border-border px-2 pt-2 pb-1" aria-label="Upcoming">
      <div class="px-2.5 pb-1 text-xs font-medium text-muted">Upcoming</div>
      <div class="max-h-[200px] overflow-y-auto">
        {days.length === 0 ? (
          syncing ? (
            <div role="status">
              <span class="sr-only">Loading upcoming events…</span>
              {[0, 1, 2].map((i) => (
                <div key={i} class="flex items-center gap-2 px-2.5 py-1.5" aria-hidden="true">
                  <span class="h-3 w-10 shrink-0 animate-pulse rounded-full bg-surface-2" />
                  <span
                    class="h-3 flex-1 animate-pulse rounded-full bg-surface-2"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p class="px-2.5 py-1.5 text-xs text-muted">Nothing coming up</p>
          )
        ) : (
          days.map((day) => (
            <div key={day.key}>
              <div class="todo-heading px-2.5 pt-1">{day.label}</div>
              {day.rows.map((row, i) => (
                <button
                  key={i}
                  type="button"
                  class="flex w-full items-baseline gap-1.5 rounded px-2.5 py-1 text-left text-xs hover:bg-surface-2"
                  title={row.title}
                  onClick={() => gotoCalendarQuery({ date: day.key })}
                >
                  <span class="w-14 shrink-0 tabular-nums text-muted">{row.time}</span>
                  <span class="min-w-0 truncate">{row.title}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
