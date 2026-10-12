/** @jsxImportSource preact */
/**
 * §9.2 month/year dropdown navigation: in month view the period label splits
 * into two ghost-button dropdowns (12 months / displayed year ±10) that
 * navigate via gotoDate. Popover chrome (.period-popover / .period-option,
 * theme.css from W4) positions inside each `relative` anchor; pickers close on
 * outside click or Esc.
 */
import { useEffect, useRef } from 'preact/hooks'
import { format } from 'date-fns'
import { Icon } from '../../ui/icons'

/** The displayed period, tracked by CalendarView from datesSet. */
interface PeriodCursor {
  y: number
  m: number
}

/** Month display names (date-fns default locale). */
const MONTH_NAMES = Array.from({ length: 12 }, (_, m) => format(new Date(2026, m, 1), 'MMMM'))

export function PeriodPickers(props: {
  cursor: PeriodCursor
  pop: 'month' | 'year' | null
  setPop: (pop: 'month' | 'year' | null) => void
  onPick: (date: Date) => void
}) {
  const { cursor, pop, setPop, onPick } = props

  // Focus restore: the trigger of whichever picker just closed gets focus
  // back (option select / outside click / Esc); month↔year swaps skip it.
  const prevPopRef = useRef<'month' | 'year' | null>(pop)
  useEffect(() => {
    const prevPop = prevPopRef.current
    prevPopRef.current = pop
    if (pop === null && prevPop !== null) {
      document
        .querySelector<HTMLButtonElement>(`[data-period-trigger='${prevPop}']`)
        ?.focus()
    }
  }, [pop])

  // Outside click / Esc dismiss (§9.2); clicks inside popovers or on the
  // triggers keep the picker open (the trigger toggles itself).
  useEffect(() => {
    if (pop === null) return
    const close = (e: Event): void => {
      if (e.type === 'keydown') {
        if ((e as KeyboardEvent).key !== 'Escape') return
      } else if (e.target instanceof Element && e.target.closest('.period-popover, [data-period-trigger]')) {
        return
      }
      setPop(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [pop, setPop])

  return (
    <div class="flex min-w-0 items-center gap-1">
      <div class="relative">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-period-trigger="month"
          title="Choose month"
          onClick={() => setPop(pop === 'month' ? null : 'month')}
        >
          {MONTH_NAMES[cursor.m]}
          <Icon.chevronDown size={14} />
        </button>
        {pop === 'month' && (
          <div class="period-popover" role="listbox" aria-label="Month">
            {MONTH_NAMES.map((name, m) => (
              <button
                key={name}
                type="button"
                role="option"
                class={`period-option${m === cursor.m ? ' is-active' : ''}`}
                aria-selected={m === cursor.m}
                onClick={() => onPick(new Date(cursor.y, m, 1))}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="relative">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-period-trigger="year"
          title="Choose year"
          onClick={() => setPop(pop === 'year' ? null : 'year')}
        >
          {cursor.y}
          <Icon.chevronDown size={14} />
        </button>
        {pop === 'year' && (
          <div class="period-popover" role="listbox" aria-label="Year">
            {Array.from({ length: 21 }, (_, i) => cursor.y - 10 + i).map((y) => (
              <button
                key={y}
                type="button"
                role="option"
                class={`period-option${y === cursor.y ? ' is-active' : ''}`}
                aria-selected={y === cursor.y}
                onClick={() => onPick(new Date(y, cursor.m, 1))}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
