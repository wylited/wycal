/**
 * Account discovery + DAV KV plumbing (lib/kv seam, CONTRACTS §36) for the
 * sync engine.
 *
 * Per account: cached `current-user-principal` + calendar/addressbook home
 * sets under `wycal.discovery.<accountId>`; a cached discovery is reused
 * as-is and revalidated from scratch when the server 404s it (stale home).
 * Clients are cached per account id — one `CaldavClient` instance keeps its
 * collection-kind cache warm across sync rounds.
 */
import { CaldavClient } from '../caldav/client'
import type { DavAccount, DavCollection } from '../caldav/types'
import { kv } from '../kv'

const DISCOVERY_PREFIX = 'wycal.discovery.'

// ---------------------------------------------------------------------------
// KV plumbing (persistence only via lib/kv — CONTRACTS §36)
// ---------------------------------------------------------------------------

function readJson<T>(key: string): T | null {
  try {
    const raw = kv.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch (err) {
    console.warn(`wycal: could not read ${key}`, err)
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    kv.set(key, JSON.stringify(value))
  } catch (err) {
    console.warn(`wycal: could not persist ${key}`, err)
  }
}

export function removeLocal(key: string): void {
  try {
    kv.remove(key)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Clients (cached per account)
// ---------------------------------------------------------------------------

interface CachedClient {
  client: CaldavClient
  /** Secret the client's auth header was built from — detects stale caches. */
  password: string
}

const clientsByAccount = new Map<string, CachedClient>()

/**
 * Client for an account. The auth header bakes the secret in at construction,
 * so the cache is rebuilt whenever the resolved password changes (e.g. an
 * Unlock after a wrong password). A missing secret never reaches the client
 * silently — the engine's sync guard reports `Password required` first; this
 * throw is the defensive backstop for direct callers.
 */
export function clientForAccount(account: DavAccount): CaldavClient {
  if (account.password === '') throw new Error('Password required — unlock the account in Settings')
  const cached = clientsByAccount.get(account.id)
  if (cached && cached.password === account.password) return cached.client
  const client = new CaldavClient(account)
  clientsByAccount.set(account.id, { client, password: account.password })
  return client
}

export function dropClient(accountId: string): void {
  clientsByAccount.delete(accountId)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryCache {
  principal: string
  calendarHome?: string
  contactHome?: string
}

export async function fullDiscovery(client: CaldavClient, accountId: string): Promise<DiscoveryCache> {
  const principal = await client.discoverPrincipal()
  const homes = await client.discoverHomeSets(principal)
  const disc: DiscoveryCache = {
    principal,
    calendarHome: homes.calendarHome,
    contactHome: homes.contactHome,
  }
  writeJson(DISCOVERY_PREFIX + accountId, disc)
  return disc
}

/** Cached discovery when usable, else a fresh discovery (persisted). */
export async function discoveryFor(client: CaldavClient, accountId: string): Promise<DiscoveryCache> {
  const cached = readJson<DiscoveryCache>(DISCOVERY_PREFIX + accountId)
  if (cached && typeof cached.principal === 'string' && (cached.calendarHome || cached.contactHome)) {
    return cached
  }
  return fullDiscovery(client, accountId)
}

export function clearDiscovery(accountId: string): void {
  removeLocal(DISCOVERY_PREFIX + accountId)
}

/** Collections under the account's home sets (dedup — Radicale homes coincide). */
export async function listAccountCollections(
  client: CaldavClient,
  disc: DiscoveryCache,
): Promise<DavCollection[]> {
  const homes = [...new Set([disc.calendarHome, disc.contactHome].filter((h): h is string => Boolean(h)))]
  if (homes.length === 0) throw new Error('account exposes no calendar/addressbook home set')
  // Homes are independent PROPFINDs — run them concurrently, then dedup in
  // home-set order (Promise.all preserves input order).
  const lists = await Promise.all(homes.map((home) => client.listCollections(home)))
  const all: DavCollection[] = []
  const seen = new Set<string>()
  for (const cols of lists) {
    for (const col of cols) {
      if (seen.has(col.url)) continue
      seen.add(col.url)
      all.push(col)
    }
  }
  return all
}

/** Server path (account proxy prefix stripped) of a full collection URL. */
export function serverPathOf(accountUrl: string, fullUrl: string): string {
  let prefix = '/'
  try {
    prefix = new URL(accountUrl).pathname.replace(/\/+$/, '') || '/'
  } catch {
    /* keep '/' */
  }
  let p: string
  try {
    p = new URL(fullUrl).pathname
  } catch {
    return fullUrl
  }
  if (prefix !== '/' && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/'
  return p
}
