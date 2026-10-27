/**
 * Whole-store offline snapshot (CONTRACTS §36): aggregates the
 * five server-derived record stores into one JSON-serializable value,
 * persisted under one kv key after syncs and hydrated BEFORE first
 * render — cached UI instantly, full resync in the background afterwards.
 * The server stays the source of truth: hydrate only restores memory state;
 * it never writes kv, never toasts, never touches the network. Secrets are
 * never part of the snapshot — the accounts section carries identity rows
 * only (see stores/accounts).
 */
import { hydrateSnapshot as hydrateAccounts, serializeSnapshot as serializeAccounts } from './accounts'
import { hydrateSnapshot as hydrateCalendars, serializeSnapshot as serializeCalendars } from './calendars'
import { hydrateSnapshot as hydrateContacts, serializeSnapshot as serializeContacts } from './contacts'
import { hydrateSnapshot as hydrateEvents, serializeSnapshot as serializeEvents } from './events'
import { hydrateSnapshot as hydrateTodos, serializeSnapshot as serializeTodos } from './todos'
import { kv } from '../lib/kv'

/** Kv key holding the last persisted snapshot (offline boot). */
export const SNAPSHOT_STORAGE_KEY = 'wycal.snapshot'

/** Snapshot format version; hydrate ignores snapshots carrying any other. */
export const SNAPSHOT_VERSION = 1

/** Aggregate shape: one section per hydrated store, all JSON-serializable. */
export interface WycalSnapshot {
  version: 1
  savedAt: string
  stores: Record<'accounts' | 'calendars' | 'events' | 'todos' | 'contacts', unknown>
}

/** Capture all five stores into one JSON-serializable snapshot. */
export function serializeSnapshot(): WycalSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    stores: {
      accounts: serializeAccounts(),
      calendars: serializeCalendars(),
      events: serializeEvents(),
      todos: serializeTodos(),
      contacts: serializeContacts(),
    },
  }
}

/** Write the aggregate snapshot to the kv seam as one JSON blob. Never throws. */
export function persistSnapshot(): void {
  try {
    kv.set(SNAPSHOT_STORAGE_KEY, JSON.stringify(serializeSnapshot()))
  } catch (err) {
    console.warn('wycal: could not persist offline snapshot', err)
  }
}

/**
 * Read back the persisted snapshot; null when absent, unparsable, or not an
 * object (the hydrate-side version/shape guards do the rest). Never throws.
 */
export function loadPersistedSnapshot(): WycalSnapshot | null {
  try {
    const raw = kv.get(SNAPSHOT_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as WycalSnapshot) : null
  } catch {
    return null
  }
}

/**
 * Restore all five stores from `snap`. Unknown shapes, null/undefined, and
 * foreign versions are no-ops; each section is guarded so one malformed
 * store never blocks the others (every per-store hydrate also guards
 * itself). Never throws.
 */
export function hydrateSnapshot(snap: WycalSnapshot | unknown): void {
  if (typeof snap !== 'object' || snap === null) return
  const s = snap as { version?: unknown; stores?: unknown }
  if (s.version !== SNAPSHOT_VERSION) return
  if (typeof s.stores !== 'object' || s.stores === null) return
  const sections = s.stores as Record<string, unknown>
  const applies: [keyof WycalSnapshot['stores'], (v: unknown) => void][] = [
    ['accounts', hydrateAccounts],
    ['calendars', hydrateCalendars],
    ['events', hydrateEvents],
    ['todos', hydrateTodos],
    ['contacts', hydrateContacts],
  ]
  for (const [section, apply] of applies) {
    try {
      apply(sections[section])
    } catch {
      // Outer belt: per-store hydrates guard themselves; a section that
      // still throws is skipped, leaving that store untouched.
    }
  }
}
