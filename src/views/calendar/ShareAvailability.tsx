/** @jsxImportSource preact */
/**
 * Share availability (KashCal-inspired): modal listing FREE slots for the
 * next 7 days (today first) within working hours 09:00–18:00 at 30-min
 * granularity. A slot is free when no visible calendar event overlaps it;
 * todos are ignored (occurrences() is events-only). Free ranges render as
 * .chip rows ("09:00–10:30, 13:00–15:00"); fully-busy days show
 * 'No free slots'. Footer copies a plain-text summary to the clipboard.
 * Shared Modal provides the dialog gate, Esc, backdrop and focus trap.
 */
import { occurrences } from '../../stores/events';
import type { EventRecord } from '../../stores/events';
import { isCalendarVisible } from '../../stores/calendars';
import { icsDateToDate } from '../../lib/ics/types';
import { addDays } from '../../lib/util/date';
import { Modal } from '../../ui/Modal';
import { push } from '../../stores/toasts';

const WORK_START_MIN = 9 * 60; // 09:00 local
const WORK_END_MIN = 18 * 60; // 18:00 local
const SLOT_MIN = 30;
const DAY_COUNT = 7;

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MO = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

interface DayAvailability {
  /** Wall-clock label, e.g. "Mon Oct 12". */
  label: string;
  /** Merged free ranges "HH:mm–HH:mm" (empty = fully busy). */
  ranges: string[];
}

/** `540` → "09:00" (24h, matches the slot grid). */
function hhmm(minOfDay: number): string {
  const h = Math.floor(minOfDay / 60);
  const m = minOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Local wall-clock timestamp for `base`'s day at `minOfDay` minutes (DST-safe). */
function atMinute(base: Date, minOfDay: number): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setMinutes(minOfDay);
  return d.getTime();
}

function dayLabel(d: Date): string {
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Free ranges per day for the next DAY_COUNT days. Uses occurrences() with
 * the same {start,end} ISO range args as every other caller; visibility is
 * gated with isCalendarVisible like useCalendarEvents.
 */
function computeAvailability(now: Date): DayAvailability[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowEnd = addDays(today, DAY_COUNT);
  const busy = occurrences({
    start: today.toISOString(),
    end: windowEnd.toISOString(),
  })
    .filter((rec: EventRecord) => isCalendarVisible(rec.calendarUrl))
    .map((rec) => ({
      start: icsDateToDate(rec.data.start).getTime(),
      end: icsDateToDate(rec.data.end).getTime(),
    }));

  const days: DayAvailability[] = [];
  for (let i = 0; i < DAY_COUNT; i++) {
    const day = addDays(today, i);
    const ranges: string[] = [];
    let rangeStart = -1;
    for (let min = WORK_START_MIN; min < WORK_END_MIN; min += SLOT_MIN) {
      const slotStart = atMinute(day, min);
      const slotEnd = slotStart + SLOT_MIN * 60_000;
      const overlaps = busy.some((e) => e.start < slotEnd && e.end > slotStart);
      if (!overlaps) {
        if (rangeStart < 0) rangeStart = min;
      } else if (rangeStart >= 0) {
        ranges.push(`${hhmm(rangeStart)}–${hhmm(min)}`);
        rangeStart = -1;
      }
    }
    if (rangeStart >= 0) ranges.push(`${hhmm(rangeStart)}–${hhmm(WORK_END_MIN)}`);
    days.push({ label: dayLabel(day), ranges });
  }
  return days;
}

function plainText(days: DayAvailability[]): string {
  return days
    .map((d) => `${d.label}: ${d.ranges.length > 0 ? d.ranges.join(', ') : 'No free slots'}`)
    .join('\n');
}

export function ShareAvailability(props: { open: boolean; onClose: () => void }) {
  // Computed per render while open: occurrences() is signal-backed, so a
  // sync that lands while the dialog is up refreshes the slots live.
  const days = props.open ? computeAvailability(new Date()) : [];

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(plainText(days));
      push('success', 'Availability copied');
    } catch {
      push('error', 'Could not copy availability');
    }
  };

  return (
    <Modal
      open={props.open}
      title="Share availability"
      onClose={props.onClose}
      footer={
        <>
          <button type="button" class="btn btn-primary" onClick={() => void copy()}>
            Copy as text
          </button>
          <button type="button" class="btn" onClick={props.onClose}>
            Close
          </button>
        </>
      }
    >
      <p class="text-xs text-muted">
        Free slots for the next 7 days, working hours {hhmm(WORK_START_MIN)}–{hhmm(WORK_END_MIN)}.
      </p>
      <div class="flex flex-col gap-2">
        {days.map((d) => (
          <div key={d.label}>
            <div class="text-xs font-medium text-muted">{d.label}</div>
            <div class="mt-1 flex flex-wrap gap-1">
              {d.ranges.length === 0 ? (
                <span class="text-xs text-muted">No free slots</span>
              ) : (
                d.ranges.map((r) => (
                  <span key={r} class="chip">
                    {r}
                  </span>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
