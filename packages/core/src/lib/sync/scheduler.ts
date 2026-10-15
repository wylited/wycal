/**
 * Sync scheduler (CONTRACTS §4): background polling driver.
 *
 * Every 60s — and once whenever the tab becomes visible again — ask the
 * engine for a debounced delta sync of every known collection. The engine
 * owns all DAV state; this module only owns timers.
 */
import { requestSyncAll } from './engine'

const POLL_INTERVAL_MS = 60_000

/** DOM timer id (lib: DOM — no Node typings in this SPA). */
let timer: number | null = null
let onVisibilityChange: (() => void) | null = null

/** Start the 60s poll + visibilitychange listener. Idempotent. */
export function startSync(): void {
  if (timer !== null) return
  // In browsers setInterval returns a number; bun-types (pulled in for bun:test) types it
  // as Node's Timeout. This SPA runs only in the DOM — coerce to the DOM contract.
  timer = setInterval(() => requestSyncAll(), POLL_INTERVAL_MS) as unknown as number
  if (typeof document !== 'undefined') {
    onVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestSyncAll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
}
