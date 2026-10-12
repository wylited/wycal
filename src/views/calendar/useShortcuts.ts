/**
 * Calendar-scope keyboard shortcuts (CONTRACTS §6/§16; active while the #/ route
 * is mounted): d/w/W/m/a view switches, t/. today, T → #/tasks, ←/→/, period
 * navigation (funneled through `navigate` for the §22 view-motion classes),
 * +/- N-days step, E event details of the selected event, ⌫/Delete delete flow
 * on the selected event, Z most-recent toast action. Global keys (n/N/c/C/s/x/
 * q/?/1–9, `\` scratch notes) live in the app.tsx handler; `/` focuses the
 * header search from there too. Suppressed in inputs and while a dialog or the
 * recurring-edit scope modal is up.
 */
import { useEffect } from 'preact/hooks'
import type { CalendarApi } from '@fullcalendar/core'
import { ROUTES } from '../../routes'
import { isDialogOpen, isEditableTarget } from '../../stores/ui'
import { runToastAction, toasts } from '../../stores/toasts'

/** Views the shortcuts switch to (a subset of the toolbar's HashView). */
type ShortcutView = 'day' | 'week' | '2weeks' | 'month' | 'agenda'

/** Wire the document-level keydown handler for the calendar view. */
export function useShortcuts(options: {
  getApi: () => CalendarApi | null
  switchView: (view: ShortcutView) => void
  /** True while the recurring-edit scope modal is pending. */
  scopePending: () => boolean
  /** N-days stepper −/+ (1–14 clamp lives in the view's stepNDays). */
  stepNDays: (delta: 1 | -1) => void
  /** Prev/next/today navigation (§22: adds the enter-motion class). */
  navigate: (dir: 'prev' | 'next' | 'today') => void
  /** `E` (§22): detail popover for the selected event (no-op if none). */
  openEventDetails: () => void
  /** `⌫`/`Delete` (§22): delete flow for the selected event (no-op if none). */
  deleteSelectedEvent: () => void
}): void {
  const { getApi, switchView, scopePending, stepNDays, navigate, openEventDetails, deleteSelectedEvent } = options
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      if (isDialogOpen() || scopePending()) return
      const api = getApi()
      if (!api) return
      switch (e.key) {
        case 'd': switchView('day'); break
        case 'w': switchView('week'); break
        case 'W': switchView('2weeks'); break
        case 'm': switchView('month'); break
        case 'a': switchView('agenda'); break
        // §16 binds Today to `.`; `t` stays as an alias since `T`/tasks
        // is a distinct key.
        case 't': case '.': navigate('today'); break
        case 'T': window.location.hash = `#${ROUTES.tasks}`; break
        case 'ArrowLeft': case ',': navigate('prev'); break
        case 'ArrowRight': navigate('next'); break
        case '+': stepNDays(1); break
        case '-': stepNDays(-1); break
        // §22 selection keys: the detail popover's Edit/Delete without the
        // mouse, and the toast action's Undo from the keyboard.
        case 'e': openEventDetails(); break
        case 'Backspace': case 'Delete': deleteSelectedEvent(); break
        case 'z': {
          const t = toasts.value[toasts.value.length - 1]
          if (t) runToastAction(t.id)
          break
        }
        default: return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [getApi, switchView, scopePending, stepNDays, navigate, openEventDetails, deleteSelectedEvent])
}
