/**
 * Contact store (CONTRACTS §4): Map<href, ContactRecord> + the same CRUD
 * shape as the events store — optimistic insert/update/delete with snapshot
 * rollback + toast on failure, etag refresh on success, and a debounced
 * `requestSync` of the owning addressbook after every mutation.
 */
import { signal } from '@preact/signals'
import type { CaldavClient } from '../lib/caldav/client'
import type { Vcard } from '../lib/vcard/types'
import { serializeVcard } from '../lib/vcard/serialize'
import { clientForCollection, httpStatus, requestSync } from '../lib/sync/engine'
import { newUid } from '../lib/util/id'
import { push } from './toasts'

export interface ContactRecord {
  href: string
  etag: string
  data: Vcard
}

export type ContactPatch = Partial<Omit<Vcard, 'uid' | 'raw'>>
/** One fetched addressbook object, already parsed into its VCARDs. */
export interface ParsedContactObject {
  href: string
  etag: string
  vcards: Vcard[]
}

export const contacts = signal<Map<string, ContactRecord>>(new Map())

/**
 * Sidebar tag filter (ContactsSidebar ↔ ContactsView): tags a contact must
 * ALL carry (AND) to appear in the list. Empty list = no tag filtering.
 */
export const contactTagFilter = signal<string[]>([])

/**
 * One-shot "open this contact" request from outside the main view (sidebar
 * birthdays, note @mentions). ContactsView consumes it: opens the detail
 * popover anchored to the list body, then clears the signal. `at` lets a
 * repeated click on the same contact re-trigger the effect.
 */
export const openContactRequest = signal<{ href: string; at: number } | null>(null)

/** Raise an open-contact request (callers don't touch the signal shape). */
export function requestOpenContact(href: string): void {
  openContactRequest.value = { href, at: Date.now() }
}

/**
 * Bumped by `applyContactsSync` whenever a sync could change contact content
 * (live binding — importers read the current value). The engine's birthday
 * materializer uses it to skip no-op runs.
 */
export let contactsRevision = 0

function hrefForContact(addressbookUrl: string, uid: string): string {
  return `${addressbookUrl.replace(/\/+$/, '')}/${uid}.vcf`
}

function requireClient(addressbookUrl: string): CaldavClient {
  const client = clientForCollection(addressbookUrl)
  if (!client) {
    push('error', 'No account found for this address book')
    throw new Error(`wycal: no account for collection ${addressbookUrl}`)
  }
  return client
}

function failureMessage(err: unknown, action: string): string {
  const status = httpStatus(err)
  if (status === 412) return 'This contact changed on the server — reloading the latest version'
  if (status === 401 || status === 403) return 'Server rejected the change (permission denied)'
  const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
  return `Could not ${action}${detail}`
}

function rollbackTo(map: Map<string, ContactRecord>): void {
  contacts.value = map
}

function retag(href: string, etag: string): void {
  const prev = contacts.value.get(href)
  if (!prev || prev.etag === etag) return
  const next = new Map(contacts.value)
  next.set(href, { ...prev, etag })
  contacts.value = next
}

/** Does this object href live inside the given addressbook collection? */
function isOwnedBy(href: string, addressbookUrl: string): boolean {
  return href.startsWith(`${addressbookUrl.replace(/\/+$/, '')}/`)
}

/** Engine feed: apply a whole-collection or delta sync in one Map swap. */
export function applyContactsSync(
  addressbookUrl: string,
  objs: ParsedContactObject[],
  deletedHrefs: string[],
  full: boolean,
): void {
  const next = new Map(contacts.value)
  const liveHrefs = new Set<string>()
  for (const o of objs) {
    liveHrefs.add(o.href)
    for (const v of o.vcards) {
      if (!v.uid) continue
      next.set(o.href, { href: o.href, etag: o.etag, data: v })
    }
  }
  if (full) {
    for (const href of next.keys()) {
      if (isOwnedBy(href, addressbookUrl) && !liveHrefs.has(href)) next.delete(href)
    }
  }
  for (const href of deletedHrefs) next.delete(href)
  contacts.value = next
  // Syncs that could change content bump the revision the engine's birthday
  // materializer watches; empty no-change deltas (60s polls) leave it alone.
  if (objs.length > 0 || deletedHrefs.length > 0 || full) contactsRevision += 1
}

export async function createContact(addressbookUrl: string, v: Vcard): Promise<ContactRecord> {
  const client = requireClient(addressbookUrl)
  const data: Vcard = { ...v, uid: v.uid || newUid() }
  const href = hrefForContact(addressbookUrl, data.uid)
  const rec: ContactRecord = { href, etag: '', data }
  const before = contacts.value
  setEntry(href, rec)
  try {
    const etag = await client.putObject(href, serializeVcard(data))
    retag(href, etag)
    void requestSync(addressbookUrl)
    return { ...rec, etag }
  } catch (err) {
    rollbackTo(before)
    if (httpStatus(err) === 412) void requestSync(addressbookUrl)
    push('error', failureMessage(err, 'create the contact'))
    throw err
  }
}

function setEntry(href: string, rec: ContactRecord): void {
  const next = new Map(contacts.value)
  next.set(href, rec)
  contacts.value = next
}

export async function updateContact(record: ContactRecord, patch: ContactPatch): Promise<void> {
  const client = requireClient(record.href)
  const nextData: Vcard = { ...record.data, ...patch, rev: new Date().toISOString() }
  const before = contacts.value
  setEntry(record.href, { ...record, data: nextData })
  try {
    const etag = await client.putObject(record.href, serializeVcard(nextData), record.etag)
    retag(record.href, etag)
    void requestSync(hrefOfCollection(record.href))
  } catch (err) {
    rollbackTo(before)
    if (httpStatus(err) === 412) void requestSync(hrefOfCollection(record.href))
    push('error', failureMessage(err, 'save the contact'))
    throw err
  }
}

export async function deleteContact(record: ContactRecord): Promise<void> {
  const client = requireClient(record.href)
  const before = contacts.value
  const next = new Map(contacts.value)
  next.delete(record.href)
  contacts.value = next
  try {
    await client.deleteObject(record.href, record.etag)
    void requestSync(hrefOfCollection(record.href))
  } catch (err) {
    rollbackTo(before)
    void requestSync(hrefOfCollection(record.href))
    push('error', failureMessage(err, 'delete the contact'))
    throw err
  }
}

/** Parent collection URL of an object href (strip the last path segment). */
function hrefOfCollection(href: string): string {
  const idx = href.lastIndexOf('/')
  return idx > 0 ? href.slice(0, idx) : href
}
