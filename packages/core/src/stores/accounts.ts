/**
 * Account store (CONTRACTS §4): identity persists to the device KV (lib/kv
 * seam) under `wycal.accounts` — id/url/username/rememberPassword, NEVER a
 * password. Secrets live in memory + the session KV `wycal.secrets`; they
 * reach the device KV `wycal.secrets.remembered` (plain text) only for
 * accounts where the user explicitly enabled Remember (default OFF).
 */
import { signal } from '@preact/signals-core'
import type { DavAccount } from '../lib/caldav/types'
import { kv, kvSession } from '../lib/kv'
import { randomUuid } from '../lib/util/id'

const ACCOUNTS_STORAGE_KEY = 'wycal.accounts'
const SECRETS_SESSION_KEY = 'wycal.secrets'
const SECRETS_REMEMBERED_KEY = 'wycal.secrets.remembered'

/** Persisted identity row — deliberately has no password field. */
interface StoredAccount {
  id: string
  url: string
  username: string
  rememberPassword: boolean
}

type SecretMap = Record<string, string>

function isStoredAccount(v: unknown): v is StoredAccount {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  return typeof a.id === 'string' && typeof a.url === 'string' && typeof a.username === 'string'
}

function persistStored(rows: StoredAccount[]): void {
  try {
    kv.set(ACCOUNTS_STORAGE_KEY, JSON.stringify(rows))
  } catch (err) {
    console.warn('wycal: could not persist accounts', err)
  }
}

function loadStored(): StoredAccount[] {
  try {
    const raw = kv.get(ACCOUNTS_STORAGE_KEY)
    if (!raw) return []
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    // Legacy rows carried a plaintext `password` — accept them but drop the
    // secret, and rewrite once to purge it from the device KV.
    const hadPlaintext = stored.some(
      (v) => typeof v === 'object' && v !== null && 'password' in v,
    )
    const rows = stored.filter(isStoredAccount).map((a) => ({
      id: a.id,
      url: a.url,
      username: a.username,
      rememberPassword: a.rememberPassword === true,
    }))
    if (hadPlaintext || rows.length !== stored.length) persistStored(rows)
    return rows
  } catch (err) {
    console.warn('wycal: could not read accounts', err)
    return []
  }
}

function readSecrets(session: boolean, key: string): SecretMap {
  const store = session ? kvSession : kv
  try {
    const raw = store.get(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: SecretMap = {}
    for (const [id, secret] of Object.entries(parsed)) {
      if (typeof secret === 'string') out[id] = secret
    }
    return out
  } catch (err) {
    console.warn('wycal: could not read secrets', err)
    return {}
  }
}

function writeSecrets(session: boolean, key: string, secrets: SecretMap): void {
  const store = session ? kvSession : kv
  try {
    store.set(key, JSON.stringify(secrets))
  } catch (err) {
    console.warn('wycal: could not persist secrets', err)
  }
}

/** Tab secrets (session KV) and device secrets (Remember opt-in). */
let sessionSecrets = readSecrets(true, SECRETS_SESSION_KEY)
let rememberedSecrets = readSecrets(false, SECRETS_REMEMBERED_KEY)

function putSecret(id: string, password: string, remember: boolean): void {
  sessionSecrets = { ...sessionSecrets, [id]: password }
  writeSecrets(true, SECRETS_SESSION_KEY, sessionSecrets)
  if (remember) {
    rememberedSecrets = { ...rememberedSecrets, [id]: password }
    writeSecrets(false, SECRETS_REMEMBERED_KEY, rememberedSecrets)
  }
}

function dropSecret(id: string): void {
  if (id in sessionSecrets) {
    const { [id]: _gone, ...rest } = sessionSecrets
    sessionSecrets = rest
    writeSecrets(true, SECRETS_SESSION_KEY, rest)
  }
  if (id in rememberedSecrets) {
    const { [id]: _gone, ...rest } = rememberedSecrets
    rememberedSecrets = rest
    writeSecrets(false, SECRETS_REMEMBERED_KEY, rest)
  }
}

/** Secret usable in this tab: session first, device store when Remember is on. */
function resolveSecret(id: string, rememberPassword: boolean): string {
  return sessionSecrets[id] ?? (rememberPassword ? (rememberedSecrets[id] ?? '') : '')
}

/**
 * Rebuild runtime accounts: resolved `password` + derived `needsPassword`
 * (never persisted). Remembered secrets are rehydrated into this tab's
 * session so the flag alone survives a browser restart.
 */
function hydrate(rows: StoredAccount[]): DavAccount[] {
  return rows.map((row) => {
    const password = resolveSecret(row.id, row.rememberPassword)
    if (row.rememberPassword && password !== '' && !(row.id in sessionSecrets)) {
      sessionSecrets = { ...sessionSecrets, [row.id]: password }
      writeSecrets(true, SECRETS_SESSION_KEY, sessionSecrets)
    }
    return { ...row, password, needsPassword: password === '' }
  })
}

let stored: StoredAccount[] = loadStored()

/** All configured DAV accounts; `password`/`needsPassword` are session-derived. */
export const accounts = signal<DavAccount[]>(hydrate(stored))

type NewAccount = {
  url: string
  username: string
  password: string
  rememberPassword: boolean
}

/**
 * Canonical account URL: trimmed, trailing slashes stripped, `http://`
 * prepended when the scheme is missing — a bare `127.0.0.1:5232` would
 * otherwise die in `new URL()` during discovery with a developer-string
 * error. Exported so hosts dedupe against the stored form.
 */
export function normalizeAccountUrl(url: string): string {
  const trimmed = url.trim()
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * Add an account (id generated), persist identity, keep its secret for this
 * tab. Same normalized URL + username IS the same account: refresh its
 * secret (a re-add doubles as an unlock) instead of stacking a duplicate
 * row — the data-level guard for hosts whose Add button re-fires before a
 * re-render disables it.
 */
export function addAccount(input: NewAccount): DavAccount {
  const url = normalizeAccountUrl(input.url)
  const existing = stored.find((a) => a.url === url && a.username === input.username)
  if (existing) {
    putSecret(existing.id, input.password, existing.rememberPassword)
    accounts.value = hydrate(stored)
    return accounts.value.find((a) => a.id === existing.id) ?? accounts.value[accounts.value.length - 1]
  }
  const row: StoredAccount = {
    id: randomUuid(),
    url,
    username: input.username,
    rememberPassword: input.rememberPassword,
  }
  stored = [...stored, row]
  putSecret(row.id, input.password, row.rememberPassword)
  accounts.value = hydrate(stored)
  persistStored(stored)
  return accounts.value.find((a) => a.id === row.id) ?? accounts.value[accounts.value.length - 1]
}

/** Unlock: store the secret for this tab (and the device when Remember is on). */
export function setAccountPassword(id: string, password: string): void {
  const row = stored.find((a) => a.id === id)
  if (!row || password === '') return
  putSecret(id, password, row.rememberPassword)
  // New objects (same ids) replace the signal contents so the engine's
  // accounts effect observes the unlocked account; Settings then calls
  // engine resumeAccount, which runs the round without waiting on the effect.
  accounts.value = hydrate(stored)
}

/**
 * Toggle per-device persistence of the secret — plain text, explicit opt-in.
 * ON moves the secret into `wycal.secrets.remembered`, OFF removes it.
 */
export function setRememberPassword(id: string, remember: boolean): void {
  const row = stored.find((a) => a.id === id)
  if (!row || row.rememberPassword === remember) return
  stored = stored.map((a) => (a.id === id ? { ...a, rememberPassword: remember } : a))
  if (remember) {
    const password = sessionSecrets[id]
    if (password !== undefined) {
      rememberedSecrets = { ...rememberedSecrets, [id]: password }
      writeSecrets(false, SECRETS_REMEMBERED_KEY, rememberedSecrets)
    }
  } else if (id in rememberedSecrets) {
    const { [id]: _gone, ...rest } = rememberedSecrets
    rememberedSecrets = rest
    writeSecrets(false, SECRETS_REMEMBERED_KEY, rest)
  }
  accounts.value = hydrate(stored)
  persistStored(stored)
}

/** Remove an account, its persisted identity, and both secret stores. */
export function removeAccount(id: string): void {
  stored = stored.filter((a) => a.id !== id)
  dropSecret(id)
  accounts.value = hydrate(stored)
  persistStored(stored)
}

// ---------------------------------------------------------------------------
// Offline snapshot (CONTRACTS §36 offline boot)
// ---------------------------------------------------------------------------

/**
 * Snapshot = the identity rows verbatim (`StoredAccount[]`). NEVER includes
 * secrets: they stay wherever the host put them (kv seam / secure store),
 * and a hydrated account without a resolvable secret reads
 * `password: ''` / `needsPassword: true` until the host unlocks it.
 */
export function serializeSnapshot(): unknown {
  return stored.map((a) => ({ ...a }))
}

/**
 * Restore identity rows. Pure memory restore — no kv writes (not even the
 * session-secret promotion `hydrate()` does), no toasts, no network.
 * Malformed input (non-array / bad rows dropped) is a no-op, matching
 * fresh-boot semantics.
 */
export function hydrateSnapshot(snap: unknown): void {
  try {
    if (!Array.isArray(snap)) return
    const rows = snap.filter(isStoredAccount).map((a) => ({
      id: a.id,
      url: a.url,
      username: a.username,
      rememberPassword: a.rememberPassword === true,
    }))
    stored = rows
    accounts.value = rows.map((row) => {
      const password = resolveSecret(row.id, row.rememberPassword)
      return { ...row, password, needsPassword: password === '' }
    })
  } catch {
    // Malformed snapshot → leave the store as-is (fresh-boot semantics).
  }
}
