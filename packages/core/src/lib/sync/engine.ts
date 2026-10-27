/**
 * Sync engine (CONTRACTS §4 + local://wycal-research.md §3–§4).
 *
 * Owns all DAV traffic and funnels it into the stores. One sync ladder per
 * collection: `syncCollection` REPORT → multiget of changed hrefs → parse →
 * store apply. The first sync of a collection in a session is token-less
 * (full); later calls delta via the session's last applied token. Radicale
 * error law:
 * - 403 + `D:valid-sync-token` (`isInvalidSyncTokenError`) → drop the session
 *   token and run exactly one full (token-less) resync of that collection.
 * - 412 on conditional PUT/DELETE is handled in the stores (rollback + toast
 *   + `requestSync`); the engine never retries writes.
 * - No blind retries anywhere: every re-run consumes fresh server state (a
 *   dropped token, or local mutations that landed mid-sync).
 *
 * Identity law: the server emits hrefs as bare server paths (`/demo/x.ics`),
 * while the stores key everything by canonical FULL collection URLs (the
 * `DavCollection.url` values from discovery). `absoluteHref` normalizes
 * server hrefs to full URLs before any store apply, so record hrefs/keys and
 * `deletedHrefs` always match what the CRUD actions create.
 *
 * KV keys: `wycal.discovery.<accountId>` (see ./discovery). Sync
 * tokens are memory-only (`appliedTokens` below): the stores are in-memory,
 * so a token persisted across reloads would report zero changes against an
 * empty store on boot; leftover `wycal.sync.*` keys from older builds are
 * swept once at init.
 *
 * CONTRACTS §13 duties: multiget objects route by component
 * (VEVENT → events store, VTODO → todos store); per-account provisioning
 * MKCOLs Inbox/Birthdays when missing (`prefs.autoProvision`); the birthday
 * materializer keeps one yearly VEVENT per contact BDAY in the Birthdays
 * calendar after every contact sync.
 */
import { effect, signal } from '@preact/signals-core'
import type { CaldavClient } from '../caldav/client'
import { DavError, isInvalidSyncTokenError } from '../caldav/types'
import type { DavAccount, DavCollection, DavObject } from '../caldav/types'
import { parseIcs } from '../ics/parse'
import { serializeIcsEvent } from '../ics/serialize'
import { parseVcf } from '../vcard/parse'
import type { Vcard } from '../vcard/types'
import type { IcsEvent, IcsTodo } from '../ics/types'
import { kv, kvKeys } from '../kv'
import { allDayIcsDate } from '../util/date'
import { accounts } from '../../stores/accounts'
import { collections, dropCollections, registerCollections } from '../../stores/calendars'
import { applyCollectionSync, baseEvents, baseKey, hrefForEvent } from '../../stores/events'
import type { ParsedEventObject } from '../../stores/events'
import { applyContactsSync, contacts, contactsRevision } from '../../stores/contacts'
import type { ParsedContactObject } from '../../stores/contacts'
import { applyTodoCollectionSync } from '../../stores/todos'
import { prefs } from '../../stores/prefs'
import { hydrateSnapshot, loadPersistedSnapshot, persistSnapshot } from '../../stores/snapshot'
import {
  clearDiscovery,
  clientForAccount,
  discoveryFor,
  dropClient,
  fullDiscovery,
  listAccountCollections,
  serverPathOf,
  type DiscoveryCache,
} from './discovery'
import { startSync } from './scheduler'

// ---------------------------------------------------------------------------
// Public sync state
// ---------------------------------------------------------------------------

type AccountSyncStatus = 'ok' | 'syncing' | 'error'

interface AccountSyncState {
  state: AccountSyncStatus
  message?: string
}

/** Per-account connection health, read by the sidebar dots/settings. */
export const syncState = signal<ReadonlyMap<string, AccountSyncState>>(new Map())

function setAccountState(accountId: string, state: AccountSyncStatus, message?: string): void {
  const next: AccountSyncState =
    state === 'ok' ? { state: 'ok' } : { state, ...(message !== undefined ? { message } : {}) }
  const prev = syncState.value.get(accountId)
  if (prev && prev.state === next.state && prev.message === next.message) return
  const map = new Map(syncState.value)
  map.set(accountId, next)
  syncState.value = map
}

/**
 * Raw error text for syncState, with fetch-level failures (CaldavClient marks
 * them 'network error') translated to actionable copy — the raw message names
 * URLs and internal causes a user cannot act on.
 */
function syncErrorMessage(err: unknown): string {
  if (err instanceof DavError && err.status === 401) {
    return 'Wrong username or password — remove and re-add the account in Settings'
  }
  const message = err instanceof Error && err.message ? err.message : String(err)
  return message.includes('network error')
    ? 'Cannot reach the CalDAV server — check the URL and that the server/proxy is running.'
    : message
}

// ---------------------------------------------------------------------------
// Offline snapshot (CONTRACTS §36 offline boot)
// ---------------------------------------------------------------------------

const SNAPSHOT_DEBOUNCE_MS = 2000
let snapshotTimer: number | undefined

/**
 * Debounced offline-snapshot persist: sync rounds land stores in memory, and
 * one coalesced kv write (~2s) later the host's flush carries them to disk —
 * a cold start against a dead server renders from that snapshot. Hooked into
 * every account round and every delta round (CRUD writes settle through
 * `requestSync`'s debounced/follow-up deltas, so local edits persist too).
 */
function persistSnapshotSoon(): void {
  clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined
    persistSnapshot()
  }, SNAPSHOT_DEBOUNCE_MS) as unknown as number
}

/**
 * Restore every store from the persisted offline snapshot — run BEFORE
 * `initSync()` at boot: hydrated stores serve the first
 * render while the initial account rounds (token-less, full, pruning)
 * converge on server truth in the background. Absent, corrupt, or
 * foreign-version snapshots are a no-op (fresh-boot semantics); never throws.
 */
export function hydrateOfflineSnapshot(): void {
  const snap = loadPersistedSnapshot()
  if (snap) hydrateSnapshot(snap)
}

// ---------------------------------------------------------------------------
// Registry: collection URL → sync bookkeeping
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'wycal.sync.'
const DEBOUNCE_MS = 500

interface RegisteredCollection {
  /** canonical full URL (registry key, `DavCollection.url` identity) */
  url: string
  /** server path (proxy prefix stripped) — matches bare server hrefs */
  srvPath: string
  accountId: string
  client: CaldavClient
  kind: 'calendar' | 'addressbook'
  /** false for collections without VEVENT/VTODO/VCARD data (registered, but nothing to sync) */
  syncable: boolean
}

const registry = new Map<string, RegisteredCollection>()
/**
 * Collection URL → sync token last applied in this session. Memory-only on
 * purpose: the stores are in-memory, so a token persisted across reloads
 * would make the boot REPORT come back empty against an empty store. The
 * first sync of a collection in a session is therefore always token-less
 * (full); later calls delta from the token recorded here — after a
 * successful apply only, and never empty (empty = no token = full sync).
 */
const appliedTokens = new Map<string, string>()
/** accountId → collections as last discovered (drives the union store push). */
const collectionsByAccount = new Map<string, DavCollection[]>()
/** accountId → round promise; discovery / initial-sync / relist serialize. */
const accountRounds = new Map<string, Promise<void>>()

function prefixMatch(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(prefix + '/')
}

/**
 * Resolve an arbitrary URL/href (collection URL, object href, full URL or
 * bare server path) to its registered collection. Longest prefix wins.
 */
function resolveEntry(urlOrHref: string): RegisteredCollection | null {
  let full = urlOrHref
  let path = urlOrHref.replace(/\/+$/, '')
  try {
    const u = new URL(urlOrHref)
    full = u.origin + u.pathname.replace(/\/+$/, '')
    path = u.pathname.replace(/\/+$/, '') || '/'
  } catch {
    /* bare server path */
  }
  let best: RegisteredCollection | null = null
  let bestLen = -1
  for (const e of registry.values()) {
    const u = e.url.replace(/\/+$/, '')
    const p = e.srvPath.replace(/\/+$/, '')
    if (!prefixMatch(full, u) && !prefixMatch(path, p)) continue
    const len = Math.max(u.length, p.length)
    if (len > bestLen) {
      best = e
      bestLen = len
    }
  }
  return best
}

/** Client for a collection URL or an object href inside it. */
export function clientForCollection(urlOrHref: string): CaldavClient | undefined {
  const entry = resolveEntry(urlOrHref)
  if (entry) return entry.client
  for (const account of accounts.value) {
    // Locked account (no secret this tab): never build an auth-less client.
    if (account.password === '') continue
    if (prefixMatch(urlOrHref.replace(/\/+$/, ''), account.url.replace(/\/+$/, ''))) {
      return clientForAccount(account)
    }
  }
  return undefined
}

/** HTTP status of a `DavError`, else undefined. */
export function httpStatus(err: unknown): number | undefined {
  return err instanceof DavError ? err.status : undefined
}

/** Full URL (account base + server-absolute object path) from a server-emitted href. */
function absoluteHref(entry: RegisteredCollection, href: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(href)) return href
  const base = entry.url.slice(0, entry.url.length - entry.srvPath.length)
  return base + (href.startsWith('/') ? href : '/' + href)
}

// ---------------------------------------------------------------------------
// Store plumbing (union push + purge)
// ---------------------------------------------------------------------------

function collectionsDiffer(a: readonly DavCollection[], b: readonly DavCollection[]): boolean {
  if (a.length !== b.length) return true
  const key = (c: DavCollection) => `${c.url}|${c.name}|${c.color ?? ''}|${c.kind}|${c.components.join(',')}`
  const seen = new Set(a.map(key))
  return b.some((c) => !seen.has(key(c)))
}

/** `registerCollections` replaces the list, so push the union of all accounts. */
function pushUnionToStore(): void {
  const union: DavCollection[] = []
  for (const cols of collectionsByAccount.values()) union.push(...cols)
  if (collectionsDiffer(collections.value, union)) registerCollections(union)
}

/** Remove every record of these collections from the stores (full prune). */
function purgeRecords(urls: readonly string[]): void {
  for (const url of urls) {
    const entry = registry.get(url)
    if (!entry) continue
    if (entry.kind === 'addressbook') applyContactsSync(url, [], [], true)
    else {
      applyCollectionSync(url, [], [], true)
      applyTodoCollectionSync(url, [], [], true)
    }
  }
}

/** Register discovered collections for an account; prune vanished ones. */
function adoptCollections(account: DavAccount, client: CaldavClient, cols: DavCollection[]): void {
  const prevUrls = new Set((collectionsByAccount.get(account.id) ?? []).map((c) => c.url))
  collectionsByAccount.set(account.id, cols)
  const nextUrls = new Set(cols.map((c) => c.url))
  for (const col of cols) {
    registry.set(col.url, {
      url: col.url,
      srvPath: serverPathOf(account.url, col.url),
      accountId: account.id,
      client,
      kind: col.kind,
      syncable:
        col.kind === 'addressbook' || col.components.includes('VEVENT') || col.components.includes('VTODO'),
    })
  }
  const vanished = [...prevUrls].filter((u) => !nextUrls.has(u))
  if (vanished.length > 0) {
    purgeRecords(vanished)
    for (const url of vanished) {
      registry.delete(url)
      appliedTokens.delete(url)
    }
  }
  pushUnionToStore()
}

function cleanupAccount(accountId: string): void {
  const urls = (collectionsByAccount.get(accountId) ?? []).map((c) => c.url)
  purgeRecords(urls)
  for (const url of urls) {
    registry.delete(url)
    appliedTokens.delete(url)
  }
  clearDiscovery(accountId)
  dropClient(accountId)
  collectionsByAccount.delete(accountId)
  const next = new Map(syncState.value)
  next.delete(accountId)
  syncState.value = next
  if (urls.length > 0) dropCollections(new Set(urls))
}

// ---------------------------------------------------------------------------
// Collection sync
// ---------------------------------------------------------------------------

function parseCalObjectSafe(data: string, href: string): { events: IcsEvent[]; todos: IcsTodo[] } | null {
  try {
    const r = parseIcs(data)
    if (r.events.length === 0 && r.todos.length === 0) {
      // Zero components (e.g. an unterminated VEVENT the parser dropped) —
      // say so instead of silently skipping the resource.
      console.warn(`wycal: calendar object ${href} parsed to 0 components`)
      return null
    }
    return { events: r.events, todos: r.todos }
  } catch (err) {
    console.warn(`wycal: skipping unparsable calendar object ${href}`, err)
    return null
  }
}

function parseContactsSafe(data: string, href: string): ParsedContactObject['vcards'] | null {
  try {
    return parseVcf(data)
  } catch (err) {
    console.warn(`wycal: skipping unparsable addressbook object ${href}`, err)
    return null
  }
}

/**
 * One sync ladder for a collection. Token-less (full, with prune) on the
 * first sync of a session; a delta via the session's last applied token
 * afterwards. A 403 `D:valid-sync-token` drops the session token and runs
 * exactly one full (token-less) resync.
 */
async function syncCollectionNow(entry: RegisteredCollection): Promise<void> {
  if (!entry.syncable) return
  const token = appliedTokens.get(entry.url)
  let full = token === undefined
  let result
  try {
    result = await entry.client.syncCollection(entry.url, token)
  } catch (err) {
    if (!isInvalidSyncTokenError(err) || token === undefined) throw err
    // Radicale error law: 403 + D:valid-sync-token → drop token, full resync.
    appliedTokens.delete(entry.url)
    result = await entry.client.syncCollection(entry.url)
    full = true
  }
  let objects: DavObject[] = []
  if (result.changedHrefs.length > 0) objects = await entry.client.getObjects(result.changedHrefs)
  const deletedHrefs = result.deletedHrefs.map((h) => absoluteHref(entry, h))
  if (entry.kind === 'addressbook') {
    const parsed: ParsedContactObject[] = []
    for (const o of objects) {
      const vcards = parseContactsSafe(o.data, o.href)
      if (vcards) parsed.push({ href: absoluteHref(entry, o.href), etag: o.etag, vcards })
    }
    applyContactsSync(entry.url, parsed, deletedHrefs, full)
    // Keep the birthday VEVENTs in step with the contacts they come from.
    void materializeBirthdays()
  } else {
    const parsed: ParsedEventObject[] = []
    for (const o of objects) {
      const p = parseCalObjectSafe(o.data, o.href)
      if (!p) continue
      parsed.push({ href: absoluteHref(entry, o.href), etag: o.etag, events: p.events, todos: p.todos })
    }
    // Component routing (CONTRACTS §13): VEVENTs feed the events store,
    // VTODOs the todos store; each apply no-ops when its array is empty.
    applyCollectionSync(entry.url, parsed, deletedHrefs, full)
    applyTodoCollectionSync(entry.url, parsed, deletedHrefs, full)
  }
  // Record only after a successful apply, and never an empty token (empty =
  // server emitted none → stay on full syncs, matching the old stored-token
  // law where an empty token read back as absent).
  if (result.token) appliedTokens.set(entry.url, result.token)
}

// ---------------------------------------------------------------------------
// Sync rounds + debounced requestSync
// ---------------------------------------------------------------------------

const timers = new Map<string, number>()
const inflight = new Set<string>()
const dirty = new Set<string>()

/**
 * Debounced (500ms) delta sync of a collection. Accepts the collection URL
 * or any href inside it; both coalesce onto the canonical collection key.
 */
export function requestSync(collectionUrl: string): void {
  const entry = resolveEntry(collectionUrl)
  const key = entry ? entry.url : collectionUrl
  clearTimeout(timers.get(key))
  timers.set(
    key,
    // bun-types types setTimeout as Node's Timeout; the runtime contract here
    // is the DOM number id (same coercion as scheduler.ts).
    setTimeout(() => {
      timers.delete(key)
      void runDeltaSync(key)
    }, DEBOUNCE_MS) as unknown as number,
  )
}

/**
 * One collection sync under the inflight/dirty guard shared by the debounced
 * delta path and account rounds, so the two can never run the same
 * collection concurrently: a second entry point while the sync is in flight
 * marks the key dirty and returns; the `finally` requeues one follow-up sync
 * so changes that landed mid-sync converge. Rejects with the sync error.
 */
async function syncGuarded(entry: RegisteredCollection): Promise<void> {
  if (inflight.has(entry.url)) {
    dirty.add(entry.url) // changes landed mid-sync → converge with one follow-up
    return
  }
  inflight.add(entry.url)
  try {
    await syncCollectionNow(entry)
  } finally {
    inflight.delete(entry.url)
    if (dirty.delete(entry.url)) requestSync(entry.url)
  }
}

async function runDeltaSync(key: string): Promise<void> {
  if (inflight.has(key)) {
    dirty.add(key) // changes landed mid-sync → converge with one follow-up
    return
  }
  const entry = registry.get(key)
  if (!entry || !entry.syncable) return
  setAccountState(entry.accountId, 'syncing')
  try {
    await syncGuarded(entry)
    setAccountState(entry.accountId, 'ok')
  } catch (err) {
    setAccountState(entry.accountId, 'error', syncErrorMessage(err))
  } finally {
    persistSnapshotSoon()
  }
}

/** Delta sync of every known collection (scheduler tick / manual refresh). */
export function requestSyncAll(): void {
  // Self-heal a failed boot round (e.g. started offline): any unlocked
  // account with neither registered collections nor a round in flight gets a
  // fresh account round, so the 60s tick / visibilitychange recovers the
  // empty registry once the server is reachable again.
  for (const account of accounts.value) {
    if (account.password !== '' && !collectionsByAccount.has(account.id) && !accountRounds.has(account.id)) {
      void runAccountRound(account)
    }
  }
  for (const entry of registry.values()) {
    if (entry.syncable) requestSync(entry.url)
  }
}

// ---------------------------------------------------------------------------
// Account rounds + initSync
// ---------------------------------------------------------------------------

async function syncAccount(account: DavAccount): Promise<void> {
  if (account.password === '') {
    // Locked account (browser restarted, Remember off) — report instead of
    // hammering the network. Resume is explicit: the Settings Unlock input
    // stores the secret and calls resumeAccount; the accounts effect is the
    // backup re-run path for the still-locked round.
    setAccountState(account.id, 'error', 'Password required')
    return
  }
  setAccountState(account.id, 'syncing')
  try {
    const client = clientForAccount(account)
    const disc = await discoveryFor(client, account.id)
    let cols: DavCollection[]
    try {
      cols = await listAccountCollections(client, disc)
    } catch (err) {
      if (!(err instanceof DavError) || err.status !== 404) throw err
      // Cached home vanished server-side → revalidate discovery exactly once.
      const fresh = await fullDiscovery(client, account.id)
      cols = await listAccountCollections(client, fresh)
    }
    if (!accounts.value.some((a) => a.id === account.id)) return // removed mid-discovery
    cols = await provisionMissingDefaults(client, disc, cols)
    if (!accounts.value.some((a) => a.id === account.id)) return // removed mid-provisioning
    adoptCollections(account, client, cols)
    const entries = [...registry.values()].filter((e) => e.accountId === account.id && e.syncable)
    // Through the same inflight/dirty guard as the delta path: a collection
    // already mid-delta-sync gets marked dirty (converging via its debounced
    // follow-up) instead of running a second concurrent sync.
    const results = await Promise.allSettled(entries.map((e) => syncGuarded(e)))
    if (!accounts.value.some((a) => a.id === account.id)) return // removed mid-sync
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
    setAccountState(account.id, 'ok')
  } catch (err) {
    setAccountState(account.id, 'error', syncErrorMessage(err))
  } finally {
    persistSnapshotSoon()
  }
}

// ---------------------------------------------------------------------------
// Per-account rounds (serialization) + provisioning (CONTRACTS §13)
// ---------------------------------------------------------------------------

function runAccountRound(account: DavAccount): Promise<void> {
  const prev = accountRounds.get(account.id) ?? Promise.resolve()
  const tracked = prev
    .catch(() => {})
    .then(() => syncAccount(account))
    .finally(() => {
      if (accountRounds.get(account.id) === tracked) accountRounds.delete(account.id)
    })
  accountRounds.set(account.id, tracked)
  return tracked
}

/**
 * Re-run discovery + provisioning + initial sync for one account — the
 * post-MKCOL refresh path (new-calendar modal, unlock). Serialized behind any
 * round already in flight for the account.
 */
export function relistAccount(account: DavAccount): Promise<void> {
  return runAccountRound(account)
}

/**
 * Resume syncing one account after its secret arrives — the explicit
 * post-Unlock hook (Settings → Unlock). Resolves the account from the current
 * accounts signal (never a stale password-less object) and runs one full
 * account round (discovery + provisioning + initial sync), serialized behind
 * any round already in flight. Accounts still without a password are a quiet
 * no-op — syncAccount's 'Password required' guard stays the single skip path —
 * and the accounts effect keeps handling boot and add/remove; the round lock
 * makes the two paths converge on one round, never a loop.
 */
export function resumeAccount(id: string): Promise<void> {
  const account = accounts.value.find((a) => a.id === id)
  if (!account || account.password === '') return Promise.resolve()
  return runAccountRound(account)
}

/** Calendars every account gets when missing and autoProvision is on. */
const PROVISIONED_CALENDARS = [
  { name: 'Inbox', color: '#39bae6' },
  { name: 'Birthdays', color: '#a37acc' },
] as const

/**
 * MKCOL the standard Inbox + Birthdays calendars when the account has none
 * with those display names, then refresh the collection list once so the new
 * collections register with their real props (CONTRACTS §13). Best-effort:
 * failures warn and never block the account round.
 */
async function provisionMissingDefaults(
  client: CaldavClient,
  disc: DiscoveryCache,
  cols: DavCollection[],
): Promise<DavCollection[]> {
  if (prefs.value.autoProvision === false) return cols
  const home = disc.calendarHome
  if (!home) return cols
  const names = new Set(cols.filter((c) => c.kind === 'calendar').map((c) => c.name))
  const missing = PROVISIONED_CALENDARS.filter((d) => !names.has(d.name))
  if (missing.length === 0) return cols
  const base = home.replace(/\/+$/, '')
  let created = false
  for (const d of missing) {
    try {
      await client.mkcol(`${base}/${d.name}/`, { name: d.name, kind: 'calendar', color: d.color })
      created = true
    } catch (err) {
      console.warn(`wycal: could not provision calendar "${d.name}"`, err)
    }
  }
  if (!created) return cols
  try {
    return await listAccountCollections(client, disc)
  } catch (err) {
    console.warn('wycal: could not refresh collections after provisioning', err)
    return cols
  }
}

// ---------------------------------------------------------------------------
// Birthday materializer (CONTRACTS §13)
// ---------------------------------------------------------------------------

const BIRTHDAYS_CALENDAR = 'Birthdays'
const BIRTHDAY_UID_PREFIX = 'bday-'
const BIRTHDAY_UID_SUFFIX = '@wycal'
const BIRTHDAY_CATEGORY = 'birthday'

/**
 * All-day `YYYY-MM-DD` for a vCard BDAY: full dates keep the birth year,
 * `--MM-DD` partials take the current year, vCard 3.0 basic `YYYYMMDD`
 * normalized. Unparsable → null (contact skipped).
 */
function birthdayDateOf(bday: string): string | null {
  const s = bday.trim()
  let m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (m) return m[1]
  m = /^--(\d{2}-\d{2})/.exec(s)
  if (m) return `${new Date().getFullYear()}-${m[1]}`
  // RFC 6350 reduced accuracy without inner dashes ('--MMDD').
  m = /^--(\d{2})(\d{2})/.exec(s)
  if (m) return `${new Date().getFullYear()}-${m[1]}-${m[2]}`
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

/** `YYYY-MM-DD` + 1 day (UTC-day arithmetic; inputs come from the regexes above). */
function nextDayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

function birthdayEventFor(v: Vcard): IcsEvent | null {
  const date = v.bday ? birthdayDateOf(v.bday) : null
  if (!date) return null
  const end = nextDayOf(date)
  return {
    uid: `${BIRTHDAY_UID_PREFIX}${v.uid}${BIRTHDAY_UID_SUFFIX}`,
    summary: `${v.fn}'s birthday`,
    start: allDayIcsDate(date),
    end: allDayIcsDate(end),
    allDay: true,
    rrule: 'FREQ=YEARLY',
    exdates: [],
    attendees: [],
    alarms: [],
    categories: [BIRTHDAY_CATEGORY],
  }
}

/** Does the stored VEVENT already carry exactly what we would materialize? */
function birthdayUpToDate(existing: IcsEvent, ev: IcsEvent): boolean {
  return (
    existing.summary === ev.summary &&
    existing.allDay &&
    existing.start.date === ev.start.date &&
    existing.end.date === ev.end.date &&
    existing.rrule === ev.rrule &&
    existing.categories.join('\u0000') === ev.categories.join('\u0000')
  )
}

/**
 * Path-only view of a URL (origin stripped, trailing slashes trimmed) so a
 * contact href recorded under a different origin than its collection URL
 * (e.g. the same-origin `/dav` proxy) still matches that collection.
 */
function originStrippedPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return url.replace(/\/+$/, '')
  }
}

/**
 * Scope fingerprint for the materializer: which accounts have a Birthdays
 * calendar and which addressbooks feed it. A scope change (account added or
 * removed, Birthdays calendar created, addressbooks re-registered) must
 * re-run the materializer even when the contacts revision did not move.
 */
function materializeScopeKey(): string {
  const parts: string[] = []
  for (const [accountId, cols] of collectionsByAccount) {
    const birth = cols.find((c) => c.kind === 'calendar' && c.name === BIRTHDAYS_CALENDAR)?.url ?? '-'
    const books = cols.filter((c) => c.kind === 'addressbook').map((c) => c.url).join(',')
    parts.push(`${accountId}|${birth}|${books}`)
  }
  return parts.join(';')
}

/** Contacts revision + scope fingerprint at the last materialize run; '' = never. */
let materializeCheckpoint = ''

async function runMaterializeBirthdays(): Promise<void> {
  // No-op guard: the materializer fires after every addressbook sync, so a
  // 60s no-change poll would otherwise re-scan every contact each minute.
  // Skip while both the contacts revision and the per-account scope are
  // unchanged since the last run.
  const checkpoint = `${contactsRevision}|${materializeScopeKey()}`
  if (checkpoint === materializeCheckpoint) return
  materializeCheckpoint = checkpoint
  // Scope per account: each account materializes into its own Birthdays
  // calendar, sourcing only contacts whose hrefs live under one of THIS
  // account's registered addressbook collections. Matching runs on
  // origin-stripped paths, so cross-origin registrations still match, other
  // accounts' contacts never leak in, and this account's events are never
  // mass-deleted over an origin mismatch between href and account URL.
  for (const account of accounts.value) {
    const cal = (collectionsByAccount.get(account.id) ?? []).find(
      (c) => c.kind === 'calendar' && c.name === BIRTHDAYS_CALENDAR,
    )
    if (!cal) continue
    const client = clientForCollection(cal.url)
    if (!client) continue
    const bookPaths = (collectionsByAccount.get(account.id) ?? [])
      .filter((c) => c.kind === 'addressbook')
      .map((c) => originStrippedPath(c.url))

    // Desired set: one yearly all-day VEVENT per contact with a parsable BDAY.
    const desired = new Map<string, { ev: IcsEvent; href: string }>()
    for (const rec of contacts.value.values()) {
      const hrefPath = originStrippedPath(rec.href)
      if (!bookPaths.some((p) => prefixMatch(hrefPath, p))) continue
      const ev = birthdayEventFor(rec.data)
      if (!ev) continue
      desired.set(ev.uid, { ev, href: hrefForEvent(cal.url, ev.uid) })
    }

    for (const { ev, href } of desired.values()) {
      const existing = baseEvents.value.get(baseKey(ev.uid, cal.url))
      if (existing && birthdayUpToDate(existing.data, ev)) continue
      try {
        const etag = await client.putObject(href, serializeIcsEvent(ev), existing?.etag || undefined)
        applyCollectionSync(cal.url, [{ href, etag, events: [ev], todos: [] }], [], false)
      } catch (err) {
        // Background materializer: never toast; converge via a re-sync so the
        // store lands on server truth (e.g. a user edit winning over the 412).
        console.warn(`wycal: could not materialize birthday event ${ev.uid}`, err)
        void requestSync(cal.url)
      }
    }

    // Remove VEVENTs whose contact (or its BDAY) disappeared.
    for (const rec of [...baseEvents.value.values()]) {
      if (rec.calendarUrl !== cal.url) continue
      const uid = rec.data.uid
      if (!uid.startsWith(BIRTHDAY_UID_PREFIX) || !uid.endsWith(BIRTHDAY_UID_SUFFIX)) continue
      if (desired.has(uid)) continue
      try {
        await client.deleteObject(rec.href, rec.etag)
        applyCollectionSync(cal.url, [], [rec.href], false)
      } catch (err) {
        console.warn(`wycal: could not remove birthday event ${uid}`, err)
        void requestSync(cal.url)
      }
    }
  }
}

let materializeChain: Promise<void> = Promise.resolve()

/**
 * Materialize per-contact birthday VEVENTs into the `Birthdays` calendar
 * (CONTRACTS §13). Idempotent + quiet on the happy path: PUT only when the
 * event is absent or changed, delete when the source contact/bday is gone,
 * no toasts. Runs serialized so overlapping contact syncs cannot interleave.
 */
function materializeBirthdays(): Promise<void> {
  const run = materializeChain.then(runMaterializeBirthdays)
  materializeChain = run.catch(() => {})
  return run
}

let initialized = false

/**
 * Sync tokens are session-scoped now, so persisted `wycal.sync.*` keys left
 * by older builds have no reader — remove them once at boot.
 */
function clearLegacySyncTokens(): void {
  for (const key of kvKeys()) {
    if (key.startsWith(TOKEN_PREFIX)) kv.remove(key)
  }
}

/**
 * Kick off syncing for current accounts and watch for additions/removals.
 * Idempotent; called once from the app mount.
 */
export function initSync(): void {
  if (initialized) return
  initialized = true
  clearLegacySyncTokens()
  effect(() => {
    const list = accounts.value
    for (const account of list) {
      if (!collectionsByAccount.has(account.id) && !accountRounds.has(account.id)) {
        void runAccountRound(account)
      }
    }
    for (const id of [...collectionsByAccount.keys()]) {
      if (!list.some((a) => a.id === id)) cleanupAccount(id)
    }
  })
  startSync()
}
