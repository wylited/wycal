/**
 * Shell UI state + keyboard-gating predicates (CONTRACTS §16).
 *
 * Owns the cross-chrome signals the global handler (app.tsx), Header, Sidebar
 * and the help overlay share: sidebar visibility, help-overlay visibility,
 * and the "new event" trigger shared with the `N` key.
 */
import { signal } from '@preact/signals'
import { addMinutes } from '../lib/util/date'
import { openEditor, editor } from '../views/event-editor/editorState'
import { prefs } from './prefs'

/**
 * Sidebar/drawer visibility (source of truth; Sidebar renders from this).
 * Starts open on desktop (≥768px, where it renders as a collapsible column)
 * and closed on mobile (where it renders as an off-canvas drawer).
 */
export const sidebarOpen = signal(
  typeof matchMedia === 'undefined' ? false : matchMedia('(min-width: 768px)').matches,
)

/** Keyboard-help overlay visibility (Header `?` button, `?` key). */
export const helpOpen = signal(false)

/**
 * Recurring-edit scope dialog (CalendarView ScopeModal) is awaiting a choice.
 * Set by CalendarView when the dialog shows; part of isDialogOpen() so the
 * global keyboard handler gates while it is up.
 */
export const scopePending = signal(false)

/**
 * Open lightweight-dialog count (New calendar modal, calendar-settings
 * popover, contact editor): surfaces without their own ui-store signal bump
 * this on open/mount and again on close/unmount, so isDialogOpen() gates the
 * global shortcuts for them too. ContactEditor calls the same helpers.
 */
export const dialogCount = signal(0)

/** Register an open dialog (call when one mounts or flips to open). */
export function bumpDialogOpen(): void {
  dialogCount.value += 1
}

/** Unregister a dialog (call on unmount/close; pairs with bumpDialogOpen). */
export function bumpDialogClose(): void {
  dialogCount.value = Math.max(0, dialogCount.value - 1)
}

/**
 * Peek-layer (detail popover) count (wave 16): Event/TodoDetailPopover bump
 * these instead of the dialog counters. Popovers still suppress ordinary
 * shortcuts (isDialogOpen counts them) but do NOT block the command palette
 * — ⌘K bumps `peekClosePing` and opens over them (CalendarView closes its
 * popover when it sees the ping).
 */
export const popoverCount = signal(0)

/** Register an open peek popover (mount); pairs with bumpPopoverClose. */
export function bumpPopoverOpen(): void {
  popoverCount.value += 1
}

/** Unregister an open peek popover (unmount/close). */
export function bumpPopoverClose(): void {
  popoverCount.value = Math.max(0, popoverCount.value - 1)
}

/** Monotonic ping: 'a peek popover should close' (⌘K wants the screen). */
export const peekClosePing = signal(0)

/**
 * True when a modal dialog/editor is up (NOT for mere peek popovers). ⌘K and
 * '/' open the palette over popovers but never over modals.
 */
export function isModalOpen(): boolean {
  return dialogCount.value > 0
}

/**
 * Toggle sidebar visibility: flips the signal (App/Sidebar render from it)
 * and broadcasts `wycal:sidebar` (detail `{ open }`) for event listeners.
 */
export function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value
  window.dispatchEvent(
    new CustomEvent('wycal:sidebar', { detail: { open: sidebarOpen.value } }),
  )
}

/**
 * Fire a window CustomEvent now and once more on the next macrotask: the
 * first dispatch reaches already-mounted listeners, the second catches the
 * view still mounting from the route change that precedes it. Consumers
 * MUST be idempotent (focus + select / open-modal).
 */
export function pingRouteView(name: string): void {
  window.dispatchEvent(new CustomEvent(name))
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(name)), 0)
}

/** True when the key landed in a field that must receive typed characters. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  return (
    t !== null &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  )
}

/** A modal surface (event editor, help overlay, recurring-scope dialog, or
 *  any bumpDialogOpen-registered dialog/popover) is up. */
export function isDialogOpen(): boolean {
  return (
    editor.value !== null || helpOpen.value || scopePending.value || dialogCount.value > 0
  )
}

/** Strictly-next half-hour boundary (14:00:23 → 14:30, 14:30:00 → 15:00). */
function nextHalfHour(): Date {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + (30 - (d.getMinutes() % 30)))
  return d
}

/** Global `N`: open the event editor prefilled at the next half-hour. */
export function requestNewEvent(): void {
  const start = nextHalfHour()
  openEditor({
    mode: 'create',
    startUtc: start.toISOString(),
    endUtc: addMinutes(start, prefs.value.defaultDurationMin).toISOString(),
    allDay: false,
  })
}
