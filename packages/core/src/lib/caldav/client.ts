/**
 * CaldavClient — the frozen WebDAV/CalDAV/CardDAV data layer (CONTRACTS §3).
 *
 * Radicale law baked in (local://wycal-research.md §3, verified against
 * Radicale master `app/report.py` / `app/propfind.py`):
 * - Every request carries preemptive `Authorization: Basic` — a bare 401
 *   makes the browser pop its native login dialog.
 * - Multiget bodies must carry the SERVER paths exactly as the server
 *   emitted them (prefix-free); full URLs are accepted on input and
 *   normalized, but never written back into report bodies.
 * - Wrong multiget flavor on a collection → 403 with `D:supported-report`,
 *   so `getObjects` classifies collections by resourcetype (cached from
 *   `listCollections`, PROPFIND-sniffed otherwise) instead of guessing.
 * - Invalid/expired sync token → 403 with `D:valid-sync-token`; rethrown as
 *   `DavError` flagged `code: 'invalid-sync-token'` (`isInvalidSyncTokenError`).
 * - ETags are opaque quoted strings, passed through verbatim into
 *   `If-Match` / `If-None-Match: *`.
 */

import type { DavAccount, DavCollection, DavComponent, DavObject, SyncResult } from './types'
import { DavError } from './types'
import type { DavPropResponse, MultigetKind } from './xml'
import {
  buildMkcolBody,
  buildMultigetBody,
  buildPropfindBody,
  buildSyncCollectionBody,
  isSyncTokenError,
  parseMultistatus,
  parseSyncToken,
  xmlEscape,
} from './xml'

/** Max hrefs per multiget REPORT (CONTRACTS §3). */
const MULTIGET_CHUNK = 50
/** Max multiget REPORTs in flight at once (bounded-concurrency chunk pool). */
const MULTIGET_CONCURRENCY = 4

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** RFC 4648 base64 of the UTF-8 bytes of `s` (no btoa — must run anywhere). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 === -1 ? 0 : b1 >> 4)]
    out += b1 === -1 ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === -1 ? 0 : b2 >> 6)]
    out += b2 === -1 ? '=' : B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/** Longest collection directory (path ending in `/`) containing all paths. */
function commonCollectionDir(paths: string[]): string {
  let prefix = paths[0]
  for (const p of paths) {
    let i = 0
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++
    prefix = prefix.slice(0, i)
  }
  const slash = prefix.lastIndexOf('/')
  return slash >= 0 ? prefix.slice(0, slash + 1) : '/'
}

export class CaldavClient {
  /**
   * Request base sans trailing slash. Same-origin proxy law: when the account
   * URL carries the `/dav` proxy path (any host), requests go through the
   * page's own origin + `/dav` — the proxy only exists there, and CalDAV
   * verbs would otherwise cross-origin and die in preflight.
   */
  private readonly baseUrl: string
  /** pathname of the account url sans trailing slash ('/dav' or '') */
  private readonly davPrefix: string
  private readonly authHeader: string
  /** collection dir path (trailing slash) → kind, feeds getObjects */
  private readonly kindByPath = new Map<string, MultigetKind>()

  constructor(account: DavAccount) {
    let origin: URL
    try {
      origin = new URL(account.url)
    } catch {
      throw new Error(`caldav: invalid account url "${account.url}"`)
    }
    // The stored account.url stays untouched (display/identity); only the
    // REQUEST base normalizes: any host + '/dav' path → page origin + '/dav',
    // so localhost / 127.0.0.1 / lan-ip / hostname dev-server pages all work.
    // Outside a browser (no `location`) the absolute account URL is used as-is.
    const path = origin.pathname.replace(/\/+$/, '')
    const proxied = (path === '/dav' || path.startsWith('/dav/')) && typeof location !== 'undefined'
    this.baseUrl = proxied ? `${location.origin}/dav` : account.url.replace(/\/+$/, '')
    this.davPrefix = path
    this.authHeader = 'Basic ' + base64Utf8(`${account.username}:${account.password}`)
  }

  // -- URL law ------------------------------------------------------------

  /**
   * Normalize a href (server path or full URL) to the server-absolute path
   * Radicale speaks: strip origin, strip the `/dav` proxy prefix, guarantee a
   * leading slash. Never double-slashes or re-encodes.
   */
  private serverPath(href: string): string {
    let p = href
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p)) {
      try {
        p = new URL(p).pathname
      } catch {
        return p
      }
    }
    if (this.davPrefix && (p === this.davPrefix || p.startsWith(this.davPrefix + '/'))) {
      p = p.slice(this.davPrefix.length) || '/'
    }
    return p.startsWith('/') ? p : '/' + p
  }

  /** Full request URL for a server path, joined without double slashes. */
  private requestUrl(path: string): string {
    return this.baseUrl + (path.startsWith('/') ? path : '/' + path)
  }

  // -- transport ----------------------------------------------------------

  private async request(
    method: string,
    url: string,
    opts: { depth?: '0' | '1'; body?: string; contentType?: string; headers?: Record<string, string> } = {},
  ): Promise<{ text: string; headers: Headers }> {
    const headers: Record<string, string> = { Authorization: this.authHeader, ...opts.headers }
    if (opts.depth !== undefined) headers['Depth'] = opts.depth
    if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/xml; charset=utf-8'

    let res: Response
    try {
      res = await fetch(url, { method, headers, body: opts.body })
    } catch (e) {
      throw new Error(`caldav: ${method} ${url} network error: ${e instanceof Error ? e.message : String(e)}`)
    }
    const text = await res.text()
    if (res.status < 200 || res.status >= 300) {
      throw new DavError(`caldav: ${method} ${url} → HTTP ${res.status}`, { status: res.status, body: text })
    }
    return { text, headers: res.headers }
  }

  private async propfind(url: string, depth: '0' | '1', props: string[]): Promise<DavPropResponse[]> {
    const { text } = await this.request('PROPFIND', url, { depth, body: buildPropfindBody(props) })
    return parseMultistatus(text)
  }

  /** Kind of a collection path, cached from listCollections/mkcol or PROPFIND-sniffed. */
  private async collectionKind(collectionPath: string): Promise<MultigetKind> {
    const cached = this.kindByPath.get(collectionPath)
    if (cached) return cached
    const rs = await this.propfind(this.requestUrl(collectionPath), '0', ['D:resourcetype'])
    const resourcetype = rs[0]?.props['resourcetype'] ?? ''
    const kind: MultigetKind | null = /\bcalendar\b/.test(resourcetype)
      ? 'calendar'
      : /\baddressbook\b/.test(resourcetype)
        ? 'addressbook'
        : null
    if (!kind) {
      throw new DavError(`caldav: cannot classify collection ${collectionPath} (resourcetype: "${resourcetype}")`, {
        body: resourcetype,
      })
    }
    this.kindByPath.set(collectionPath, kind)
    return kind
  }

  // -- discovery ------------------------------------------------------------

  /**
   * PROPFIND Depth:0 `current-user-principal` at the account root.
   * Returns the principal as a server path, e.g. `/demo/`.
   */
  async discoverPrincipal(): Promise<string> {
    const rs = await this.propfind(this.baseUrl, '0', ['D:current-user-principal'])
    const principal = rs[0]?.props['current-user-principal'] ?? ''
    if (!principal) {
      throw new Error('caldav: server reported no current-user-principal (check username/password)')
    }
    return principal
  }

  /**
   * PROPFIND Depth:0 on the principal for `C:calendar-home-set` +
   * `CR:addressbook-home-set`. Values are server paths (Radicale points
   * both at the user root, e.g. `/demo/`).
   */
  async discoverHomeSets(principal: string): Promise<{ calendarHome?: string; contactHome?: string }> {
    const rs = await this.propfind(this.requestUrl(this.serverPath(principal)), '0', [
      'C:calendar-home-set',
      'CR:addressbook-home-set',
    ])
    const props = rs[0]?.props ?? {}
    const calendarHome = props['calendar-home-set'] || undefined
    const contactHome = props['addressbook-home-set'] || undefined
    return { ...(calendarHome ? { calendarHome } : {}), ...(contactHome ? { contactHome } : {}) }
  }

  /**
   * PROPFIND Depth:1 resourcetype + displayname + ICAL:calendar-color +
   * C:supported-calendar-component-set. Classifies by resourcetype, skips
   * the home collection itself and non-collection/plain entries (e.g. the
   * principal). `DavCollection.url` is the joined full URL.
   */
  async listCollections(home: string): Promise<DavCollection[]> {
    const homePath = this.serverPath(home)
    const rs = await this.propfind(this.requestUrl(homePath), '1', [
      'D:resourcetype',
      'D:displayname',
      'ICAL:calendar-color',
      'C:supported-calendar-component-set',
    ])
    const homeNoSlash = homePath.replace(/\/+$/, '')
    const collections: DavCollection[] = []
    for (const r of rs) {
      const path = this.serverPath(r.href)
      const resourcetype = r.props['resourcetype'] ?? ''
      const kind: MultigetKind | null = /\bcalendar\b/.test(resourcetype)
        ? 'calendar'
        : /\baddressbook\b/.test(resourcetype)
          ? 'addressbook'
          : null
      if (!kind) continue // principal / plain collection
      if (path.replace(/\/+$/, '') === homeNoSlash) continue // the home itself

      const dir = path.endsWith('/') ? path : path + '/'
      this.kindByPath.set(dir, kind)

      const components: DavComponent[] =
        kind === 'calendar'
          ? (r.props['supported-calendar-component-set'] ?? 'VEVENT')
              .split(/\s+/)
              .filter((c): c is 'VEVENT' | 'VTODO' | 'VCARD' => c === 'VEVENT' || c === 'VTODO' || c === 'VCARD')
          : ['VCARD']

      let name = r.props['displayname'] ?? ''
      if (!name) {
        const segment = dir.replace(/\/+$/, '').split('/').pop() ?? ''
        try {
          name = decodeURIComponent(segment)
        } catch {
          name = segment
        }
      }
      const color = r.props['calendar-color'] || undefined
      collections.push({
        url: this.requestUrl(path),
        name,
        ...(color ? { color } : {}),
        kind,
        components,
      })
    }
    return collections
  }

  // -- sync -----------------------------------------------------------------

  /**
   * sync-collection REPORT (Depth:0, sync-token + getetag). Initial sync:
   * omit `token`. Deleted members come back as bare 404-status responses;
   * changed ones as propstat'd getetag entries. A rejected token (Radicale:
   * HTTP 403 + `D:valid-sync-token`, tokens expire after 30 days) throws
   * `DavError` flagged `invalid-sync-token` — drop the token and resync.
   */
  async syncCollection(url: string, token?: string): Promise<SyncResult> {
    const path = this.serverPath(url)
    let text: string
    try {
      ;({ text } = await this.request('REPORT', this.requestUrl(path), {
        depth: '0',
        body: buildSyncCollectionBody(token),
      }))
    } catch (e) {
      if (e instanceof DavError && e.status === 403 && isSyncTokenError(e.body ?? '')) {
        throw new DavError(`caldav: sync token for ${path} rejected (invalid or expired) — full resync required`, {
          status: 403,
          body: e.body,
          code: 'invalid-sync-token',
        })
      }
      throw e
    }
    const changedHrefs: string[] = []
    const deletedHrefs: string[] = []
    for (const r of parseMultistatus(text)) {
      if (r.status !== undefined && /\b404\b/.test(r.status)) deletedHrefs.push(r.href)
      else if (r.props['getetag'] !== undefined) changedHrefs.push(r.href)
    }
    return { token: parseSyncToken(text) ?? '', changedHrefs, deletedHrefs }
  }

  /**
   * calendar-multiget / addressbook-multiget REPORT (getetag +
   * calendar-data/address-data; no Depth header — RFC 4791 §7.9: servers
   * MUST ignore it and clients SHOULD NOT send it), 50 hrefs per request,
   * up to 4 requests in flight (result order preserved). The kind is resolved
   * from the hrefs' common collection (cached from `listCollections`, else a
   * Depth:0 resourcetype PROPFIND — Radicale 403s the wrong multiget flavor).
   * Entries the server reports as gone (404 status) are skipped.
   */
  async getObjects(hrefUrls: string[]): Promise<DavObject[]> {
    const paths = hrefUrls.map((h) => this.serverPath(h)).filter((p) => p !== '/' && p !== '')
    if (paths.length === 0) return []
    const collectionPath = commonCollectionDir(paths)
    const kind = await this.collectionKind(collectionPath)

    // Chunked multigets with bounded concurrency: up to MULTIGET_CONCURRENCY
    // chunks in flight (index-pool — each lane claims the next chunk index
    // synchronously before awaiting), results written back at their chunk
    // index so the final order matches the input href order.
    const chunks: DavObject[][] = []
    let cursor = 0
    const lane = async (): Promise<void> => {
      for (;;) {
        const i = cursor
        cursor += MULTIGET_CHUNK
        if (i >= paths.length) return
        const chunk = paths.slice(i, i + MULTIGET_CHUNK)
        // RFC 4791 §7.9: multiget targets explicit hrefs, so the server MUST
        // ignore Depth and the client SHOULD NOT send it — we send none.
        const { text } = await this.request('REPORT', this.requestUrl(collectionPath), {
          body: buildMultigetBody(chunk, kind),
        })
        const found: DavObject[] = []
        for (const r of parseMultistatus(text)) {
          const etag = r.props['getetag']
          const data = r.props['calendar-data'] ?? r.props['address-data']
          if (etag === undefined && data === undefined) continue // deleted mid-flight
          found.push({ href: r.href, etag: etag ?? '', data: data ?? '' })
        }
        chunks[i / MULTIGET_CHUNK] = found
      }
    }
    const lanes = Math.min(MULTIGET_CONCURRENCY, Math.ceil(paths.length / MULTIGET_CHUNK))
    await Promise.all(Array.from({ length: lanes }, () => lane()))
    return chunks.flat()
  }

  // -- mutation ---------------------------------------------------------------

  /**
   * PUT an iCalendar/vCard resource. `etag` given → `If-Match` (optimistic
   * concurrency; conflicts surface as HTTP 412); omitted → `If-None-Match: *`
   * (create-only). `Prefer: return=minimal`. Resolves with the NEW etag from
   * the `ETag` response header; if a proxy stripped it, falls back to a
   * Depth:0 getetag PROPFIND.
   */
  async putObject(href: string, body: string, etag?: string): Promise<string> {
    const url = this.requestUrl(this.serverPath(href))
    const contentType = body.trimStart().startsWith('BEGIN:VCARD')
      ? 'text/vcard; charset=utf-8'
      : 'text/calendar; charset=utf-8'
    const headers: Record<string, string> = {
      Prefer: 'return=minimal',
      ...(etag !== undefined ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    }
    const res = await this.request('PUT', url, { body, contentType, headers })
    const etagOut = res.headers.get('ETag')
    if (etagOut) return etagOut
    const rs = await this.propfind(url, '0', ['D:getetag'])
    return rs[0]?.props['getetag'] ?? ''
  }

  /**
   * DELETE a resource with `If-Match`. A 404 (already gone server-side) is
   * treated as success — deletion is idempotent from the store's viewpoint.
   */
  async deleteObject(href: string, etag: string): Promise<void> {
    const url = this.requestUrl(this.serverPath(href))
    try {
      await this.request('DELETE', url, { headers: { 'If-Match': etag } })
    } catch (e) {
      if (e instanceof DavError && e.status === 404) return
      throw e
    }
  }

  /**
   * MKCOL a calendar (resourcetype + displayname + ICAL:calendar-color +
   * supported-calendar-component-set, defaulting to VEVENT+VTODO) or an
   * addressbook (resourcetype + displayname).
   */
  async mkcol(
    url: string,
    opts: {
      name: string
      kind: 'calendar' | 'addressbook'
      color?: string
      /** calendar-only; defaults to ['VEVENT', 'VTODO'] */
      components?: Array<'VEVENT' | 'VTODO'>
    },
  ): Promise<void> {
    const path = this.serverPath(url)
    await this.request('MKCOL', this.requestUrl(path), { body: buildMkcolBody(opts) })
    this.kindByPath.set(path.endsWith('/') ? path : path + '/', opts.kind)
  }

  /**
   * PROPPATCH set of `ICAL:calendar-color` (Apple iCal convention hex, e.g.
   * `#39bae6`), Depth 0. Radicale persists the property and echoes it back on
   * the next listCollections; a 207 multistatus counts as success (the
   * transport only throws outside 2xx). Goes through the same request-base
   * normalization as every other verb (same-origin `/dav` proxy law).
   */
  async proppatchColor(collectionUrl: string, hex: string): Promise<void> {
    const color = hex.startsWith('#') ? hex : `#${hex}`
    const body =
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<D:propertyupdate xmlns:D="DAV:" xmlns:ICAL="http://apple.com/ns/ical/">' +
      '<D:set><D:prop>' +
      `<ICAL:calendar-color>${xmlEscape(color)}</ICAL:calendar-color>` +
      '</D:prop></D:set></D:propertyupdate>'
    await this.request('PROPPATCH', this.requestUrl(this.serverPath(collectionUrl)), {
      depth: '0',
      body,
    })
  }
}
