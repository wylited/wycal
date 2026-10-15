/**
 * Toast store (CONTRACTS §4): `push(kind, msg)` appends to a capped list with
 * expiry timestamps; the UI host (`ui/Toast.tsx`) renders and auto-dismisses.
 * design.md §5: bottom-right stack, 3.5s auto-dismiss.
 */
import { signal } from '@preact/signals-core'

type ToastKind = 'info' | 'success' | 'error'

/** Inline toast action (e.g. Undo); clicking runs it and dismisses the toast. */
interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface Toast {
  id: number
  kind: ToastKind
  msg: string
  /** Epoch ms after which the host should drop the toast. */
  expiresAt: number
  action?: ToastAction
}

const TOAST_TTL_MS = 3500
/** Action toasts live longer so the button is actually clickable. */
const TOAST_ACTION_TTL_MS = 6000
const TOAST_CAP = 4

export const toasts = signal<Toast[]>([])

let nextId = 1

/** Show a toast; the list is capped at 4 (oldest dropped first). A toast with
 * an action auto-dismisses after 6s instead of 3.5s. */
export function push(kind: ToastKind, msg: string, action?: ToastAction): void {
  const list = [
    ...toasts.value,
    { id: nextId++, kind, msg, action, expiresAt: Date.now() + (action ? TOAST_ACTION_TTL_MS : TOAST_TTL_MS) },
  ]
  if (list.length > TOAST_CAP) list.splice(0, list.length - TOAST_CAP)
  toasts.value = list
}

/** Dismiss a single toast early (host close button). */
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

/** Run a toast's inline action (host button) and dismiss the toast. */
export function runToastAction(id: number): void {
  const t = toasts.value.find((x) => x.id === id)
  if (!t?.action) return
  dismissToast(id)
  void t.action.run()
}
