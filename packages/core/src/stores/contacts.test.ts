/**
 * Contact store mutation tests (CONTRACTS §4): the optimistic update path and
 * the If-Match 412 recovery — refresh the record by href, retry the patch
 * ONCE on the fresh etag (the patch is the editor's typed form, so it wins
 * over the re-read base), and surface a toast instead of retry-looping when
 * the second PUT still conflicts. The real CaldavClient runs against a mocked
 * global fetch, so the whole path — If-Match headers, multiget re-read, etag
 * retag — is exercised end-to-end without a server.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DavError } from '../lib/caldav/types'
import { parseVcf } from '../lib/vcard/parse'
import { accounts } from './accounts'
import { contacts, updateContact, type ContactRecord } from './contacts'
import { toasts } from './toasts'

const ORIGIN = 'http://127.0.0.1:5232'
const AB_PATH = '/user/contacts/'
const HREF = `${ORIGIN}${AB_PATH}card-1.vcf`

const ACCOUNT = {
  id: 'acc-1',
  url: ORIGIN,
  username: 'u',
  password: 'p',
  rememberPassword: false,
  needsPassword: false,
}

function cardText(fn: string, org?: string): string {
  return [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:card-1',
    `FN:${fn}`,
    ...(org !== undefined ? [`ORG:${org}`] : []),
    'END:VCARD',
  ].join('\r\n')
}

function recordOf(fn: string, etag: string): ContactRecord {
  return { href: HREF, etag, data: parseVcf(cardText(fn))[0]! }
}

// --- fetch mock: PROPFIND (collection kind) / REPORT (multiget) / PUT queue ---

const PROPSTAT = '<D:propstat><D:prop><D:getetag>__ETAG__</D:getetag><V:address-data>__DATA__</V:address-data></D:prop></D:propstat>'

function multistatus(inner: string): Response {
  return new Response(`<D:multistatus xmlns:D="DAV:" xmlns:V="urn:ietf:params:carddav">${inner}</D:multistatus>`, {
    status: 207,
    headers: { 'Content-Type': 'application/xml' },
  })
}

function reportResponse(etag: string, data: string): Response {
  return multistatus(
    `<D:response><D:href>${AB_PATH}card-1.vcf</D:href>${PROPSTAT.replace('__ETAG__', etag).replace('__DATA__', data)}</D:response>`,
  )
}

const PROPFIND_RESPONSE = multistatus(
  '<D:response><D:href>/user/contacts/</D:href><D:propstat><D:prop>' +
    '<D:resourcetype><D:collection/><V:addressbook/></D:resourcetype>' +
    '</D:prop></D:propstat></D:response>',
)

/** PUT outcomes, consumed in order: '412'/'403' or { etag } for success. */
let putOutcomes: ('412' | '403' | { etag: string })[] = []
const putCalls: { ifMatch: string | undefined; body: string }[] = []
let reportCount = 0
let reportCard = reportResponse('"v2"', cardText('Bob Server', 'Server Org'))

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = (init?.headers ?? {}) as Record<string, string>
  if (method === 'PROPFIND') return PROPFIND_RESPONSE
  if (method === 'REPORT') {
    reportCount += 1
    return reportCard
  }
  if (method === 'PUT') {
    const outcome = putOutcomes.shift()
    putCalls.push({ ifMatch: headers['If-Match'], body: String(init?.body ?? '') })
    if (outcome === '412') return new Response('precondition failed', { status: 412 })
    if (outcome === '403') return new Response('nope', { status: 403 })
    if (outcome !== undefined) return new Response('', { status: 204, headers: { ETag: outcome.etag } })
  }
  throw new Error(`contacts.test: unexpected ${method} ${String(input)}`)
})

const realFetch = globalThis.fetch
const realAccounts = accounts.value
const realContacts = contacts.value
const realToasts = toasts.value

beforeEach(() => {
  putOutcomes = []
  putCalls.length = 0
  reportCount = 0
  reportCard = reportResponse('"v2"', cardText('Bob Server', 'Server Org'))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  accounts.value = [ACCOUNT]
  contacts.value = new Map([[HREF, recordOf('Ada Original', '"v1"')]])
  toasts.value = []
})

afterAll(() => {
  globalThis.fetch = realFetch
  accounts.value = realAccounts
  contacts.value = realContacts
  toasts.value = realToasts
})

const record = (): ContactRecord => contacts.value.get(HREF)!

describe('updateContact — happy path', () => {
  test('one PUT on the record etag, then retag', async () => {
    putOutcomes = [{ etag: '"v2"' }]
    await updateContact(record(), { fn: 'Edited' })
    expect(putCalls).toHaveLength(1)
    expect(putCalls[0]!.ifMatch).toBe('"v1"')
    expect(putCalls[0]!.body).toContain('FN:Edited')
    expect(record().etag).toBe('"v2"')
    expect(record().data.fn).toBe('Edited')
  })
})

describe('updateContact — If-Match 412 recovery', () => {
  test('refreshes by href and retries the patch once on the fresh etag', async () => {
    putOutcomes = ['412', { etag: '"v3"' }]
    await updateContact(record(), { fn: 'Edited', title: 'Principal' })
    expect(putCalls).toHaveLength(2)
    expect(putCalls[0]!.ifMatch).toBe('"v1"')
    expect(putCalls[1]!.ifMatch).toBe('"v2"')
    // The retry body merges the PATCH over the re-read base: the editor's
    // typed form wins, the server's untouched field (ORG) rides along.
    expect(putCalls[1]!.body).toContain('FN:Edited')
    expect(putCalls[1]!.body).toContain('TITLE:Principal')
    expect(putCalls[1]!.body).toContain('ORG:Server Org')
    expect(reportCount).toBe(1)
    expect(record().etag).toBe('"v3"')
    expect(record().data.fn).toBe('Edited')
    expect(record().data.org).toBe('Server Org')
    // The single retry landing is silent — no toast.
    expect(toasts.value).toEqual([])
  })

  test('a second conflict rolls back, toasts, and rethrows instead of looping', async () => {
    putOutcomes = ['412', '412']
    await expect(updateContact(record(), { fn: 'Edited' })).rejects.toBeInstanceOf(DavError)
    expect(putCalls).toHaveLength(2)
    const restored = record()
    expect(restored.etag).toBe('"v1"')
    expect(restored.data.fn).toBe('Ada Original')
    expect(toasts.value.map((t) => t.msg)).toEqual([
      'This contact changed on the server again — please try saving once more',
    ])
  })

  test('an unreadable fresh copy surfaces the generic failure', async () => {
    putOutcomes = ['412']
    reportCard = new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 })
    await expect(updateContact(record(), { fn: 'Edited' })).rejects.toThrow()
    expect(record().etag).toBe('"v1"')
    expect(record().data.fn).toBe('Ada Original')
    expect(toasts.value).toHaveLength(1)
  })
})

describe('updateContact — other failures', () => {
  test('a non-412 PUT failure never retries and rolls the optimistic write back', async () => {
    putOutcomes = ['403']
    await expect(updateContact(record(), { fn: 'Edited' })).rejects.toBeInstanceOf(DavError)
    expect(putCalls).toHaveLength(1)
    expect(reportCount).toBe(0)
    expect(record().etag).toBe('"v1"')
    expect(record().data.fn).toBe('Ada Original')
    expect(toasts.value.map((t) => t.msg)).toEqual(['Server rejected the change (permission denied)'])
  })
})
