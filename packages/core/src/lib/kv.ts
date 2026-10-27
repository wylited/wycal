/**
 * KV persistence seam (CONTRACTS §36): the ONLY storage surface in core.
 *
 * Web defaults to localStorage/sessionStorage; other hosts boot
 * with `setKvBackend` BEFORE importing anything that reads `kv`/`kvSession`
 * (stores hydrate at module load). When neither is swapped in and no DOM
 * storage exists, an in-memory Map keeps the module graph loadable anywhere.
 */
export interface KvBackend {
  get(k: string): string | null
  set(k: string, v: string): void
  remove(k: string): void
}

/** Backend that can enumerate its keys (default backends can; custom ones may). */
interface EnumerableBackend extends KvBackend {
  keys?(): string[]
}

function memoryBackend(): EnumerableBackend {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  }
}

function webStorageBackend(storage: Storage): EnumerableBackend {
  return {
    get: (k) => storage.getItem(k),
    set: (k, v) => storage.setItem(k, v),
    remove: (k) => storage.removeItem(k),
    keys: () => {
      const out: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k !== null) out.push(k)
      }
      return out
    },
  }
}

let persistent: EnumerableBackend =
  typeof localStorage !== 'undefined' ? webStorageBackend(localStorage) : memoryBackend()
let session: EnumerableBackend =
  typeof sessionStorage !== 'undefined' ? webStorageBackend(sessionStorage) : memoryBackend()

/** Device-persistent KV (web: localStorage; hosts: the swapped-in backend). */
export const kv: KvBackend = {
  get: (k) => persistent.get(k),
  set: (k, v) => persistent.set(k, v),
  remove: (k) => persistent.remove(k),
}

/** Tab/session KV (web: sessionStorage; hosts: whatever they swap in). */
export const kvSession: KvBackend = {
  get: (k) => session.get(k),
  set: (k, v) => session.set(k, v),
  remove: (k) => session.remove(k),
}

/**
 * Swap the live backends (host boot). Both proxies flip together in one
 * synchronous step; a missing `session` falls back to the persistent backend.
 */
export function setKvBackend(persistentBackend: KvBackend, sessionBackend?: KvBackend): void {
  persistent = persistentBackend
  session = sessionBackend ?? persistentBackend
}

/**
 * Persistent keys when the backend can enumerate them (default backends can;
 * minimal custom backends cannot and report none). Used only by the legacy
 * `wycal.sync.*` sweep — never for reads of live state.
 */
export function kvKeys(): string[] {
  return typeof persistent.keys === 'function' ? persistent.keys() : []
}
