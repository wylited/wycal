/**
 * WebDAV / CalDAV XML bodies and multistatus parsing — CONTRACTS.md §3.
 *
 * Zero dependencies, byte-stable builders (identical input ⇒ identical
 * string, assertable against fixtures) and a namespace-aware reader for
 * 207 multistatus documents.
 *
 * Why not DOMParser: the module must behave identically in the browser and
 * under `bun test`, and Bun ships no DOMParser (`typeof DOMParser ===
 * 'undefined'`, bun 1.4.2). One deliberate divergence: CDATA content is
 * appended verbatim (never entity-decoded) into the parent's text — the
 * same value DOM `textContent` yields, but unlike DOMParser no separate
 * CDATASection nodes are exposed. Radicale emits plain, machine-generated
 * XML, so
 * a minimal reader with real namespace resolution (xmlns declarations,
 * default namespaces, CDATA, the five predefined entities plus numeric
 * character references) covers everything the client reads. Malformed input
 * throws from `parseXml`; the defensive parsers (`parseSyncToken`,
 * `isSyncTokenError`) never throw.
 *
 * Prop-value projections of `parseMultistatus` (props are keyed by LOCAL
 * name; all props wycal reads have distinct local names):
 * - leaf props (`getetag`, `displayname`, `calendar-color`,
 *   `calendar-data`, `address-data`): trimmed text content
 * - `resourcetype`: child local names joined with spaces,
 *   e.g. `"collection calendar"`
 * - `current-user-principal`, `calendar-home-set`, `addressbook-home-set`:
 *   the inner `D:href` text
 * - `supported-calendar-component-set`: the inner `C:comp name="…"`
 *   attributes joined with spaces, e.g. `"VEVENT VTODO"`
 * - anything else with children: child local names joined with spaces
 */

const NS = {
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CARDDAV: 'urn:ietf:params:xml:ns:carddav',
  ICAL: 'http://apple.com/ns/ical/',
  NEXTCLOUD: 'http://nextcloud.com/ns',
} as const

/** Prefixes the builders may emit; every known namespace is declared on
 *  each root element (legal XML) so bodies stay byte-stable per props set. */
const PREFIX_TO_NS: Record<string, string> = {
  D: NS.DAV,
  C: NS.CALDAV,
  CR: NS.CARDDAV,
  ICAL: NS.ICAL,
  NK: NS.NEXTCLOUD,
}

const NS_DECL =
  ' xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"' +
  ' xmlns:CR="urn:ietf:params:xml:ns:carddav"' +
  ' xmlns:ICAL="http://apple.com/ns/ical/" xmlns:NK="http://nextcloud.com/ns"'

const XML_DECL = '<?xml version="1.0" encoding="utf-8" ?>'

/** Escape the five XML metacharacters (safe in text and attribute values). */
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

/**
 * PROPFIND body requesting `props` (qualified names with known prefixes,
 * e.g. `D:getetag`, `C:calendar-data`, `ICAL:calendar-color`).
 */
export function buildPropfindBody(props: string[]): string {
  let propEls = ''
  for (const qname of props) {
    const prefix = qname.slice(0, qname.indexOf(':'))
    if (!(prefix in PREFIX_TO_NS)) {
      throw new Error(`xml.ts: unknown namespace prefix in "${qname}"`)
    }
    propEls += `<${qname}/>`
  }
  return `${XML_DECL}<D:propfind${NS_DECL}><D:prop>${propEls}</D:prop></D:propfind>`
}

/**
 * RFC 6578 sync-collection REPORT body (getetag only, per CONTRACTS §3).
 * Carries `<D:sync-level>1</D:sync-level>` (RFC 6578 §3.2 — collection
 * members only, no nested collections). An absent `token` emits an empty
 * `<D:sync-token/>` — Radicale treats a missing/empty token as "initial
 * sync, return everything".
 */
export function buildSyncCollectionBody(token?: string): string {
  const tok = token ? `<D:sync-token>${xmlEscape(token)}</D:sync-token>` : '<D:sync-token/>'
  return (
    `${XML_DECL}<D:sync-collection${NS_DECL}>${tok}<D:sync-level>1</D:sync-level>` +
    '<D:prop><D:getetag/></D:prop></D:sync-collection>'
  )
}

export type MultigetKind = 'calendar' | 'addressbook'

/**
 * calendar-multiget (RFC 4791 §7.9) or addressbook-multiget (RFC 6352 §8.7)
 * REPORT body. `hrefList` entries are SERVER paths exactly as the server
 * returned them (Radicale matches them against its own prefix-free paths).
 */
export function buildMultigetBody(hrefList: string[], kind: MultigetKind): string {
  const root = kind === 'addressbook' ? 'CR:addressbook-multiget' : 'C:calendar-multiget'
  const dataProp = kind === 'addressbook' ? '<CR:address-data/>' : '<C:calendar-data/>'
  let hrefs = ''
  for (const h of hrefList) hrefs += `<D:href>${xmlEscape(h)}</D:href>`
  return `${XML_DECL}<${root}${NS_DECL}><D:prop><D:getetag/>${dataProp}</D:prop>${hrefs}</${root}>`
}

interface MkcolBodyOptions {
  name: string
  kind: MultigetKind
  /** calendar-only; Apple iCal convention hex, e.g. `#fa8d3e` */
  color?: string
  /** calendar-only; defaults to `['VEVENT', 'VTODO']` */
  components?: Array<'VEVENT' | 'VTODO'>
}

/** MKCOL body creating a calendar or addressbook collection (CONTRACTS §3). */
export function buildMkcolBody(opts: MkcolBodyOptions): string {
  const isCalendar = opts.kind === 'calendar'
  const resourcetype = isCalendar ? '<D:collection/><C:calendar/>' : '<D:collection/><CR:addressbook/>'
  const color = isCalendar && opts.color ? `<ICAL:calendar-color>${xmlEscape(opts.color)}</ICAL:calendar-color>` : ''
  let compSet = ''
  if (isCalendar) {
    const comps = opts.components ?? ['VEVENT', 'VTODO']
    let compsXml = ''
    for (const c of comps) compsXml += `<C:comp name="${xmlEscape(c)}"/>`
    compSet = `<C:supported-calendar-component-set>${compsXml}</C:supported-calendar-component-set>`
  }
  return (
    `${XML_DECL}<D:mkcol${NS_DECL}><D:set><D:prop>` +
    `<D:resourcetype>${resourcetype}</D:resourcetype>` +
    `<D:displayname>${xmlEscape(opts.name)}</D:displayname>` +
    `${color}${compSet}</D:prop></D:set></D:mkcol>`
  )
}

// ---------------------------------------------------------------------------
// Minimal namespace-aware XML reader
// ---------------------------------------------------------------------------

interface XmlNode {
  /** resolved namespace URI ('' when none declared) */
  readonly ns: string
  readonly local: string
  /** attribute qname → decoded value (xmlns declarations included) */
  readonly attrs: Record<string, string>
  readonly children: XmlNode[]
  /** concatenated descendant text incl. CDATA (DOM textContent semantics) */
  readonly text: string
}

interface MutableXmlNode {
  ns: string
  local: string
  attrs: Record<string, string>
  children: MutableXmlNode[]
  text: string
}

interface Frame {
  qname: string
  node: MutableXmlNode
  scope: Record<string, string>
  text: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Single-pass entity decode (numeric refs included); unknown → literal. */
function decodeEntities(s: string): string {
  return s.replace(/&(#[0-9]+;|#x[0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2, -1), 16) : parseInt(e.slice(1, -1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return m
    }
    return NAMED_ENTITIES[e.slice(0, -1)] ?? m
  })
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*/

/** Index of the `>` closing the tag starting at `from` (quote-aware). */
function scanTagEnd(s: string, from: number): number {
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i
    }
  }
  throw new Error('xml.ts: unterminated tag')
}

/** Parse one well-formed XML document and return its root element. */
export function parseXml(xml: string): XmlNode {
  const s = xml
  const stack: Frame[] = []
  let root: MutableXmlNode | null = null
  let i = 0

  const appendText = (raw: string): void => {
    if (stack.length > 0) stack[stack.length - 1].text += decodeEntities(raw)
  }

  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt === -1) {
      appendText(s.slice(i))
      break
    }
    if (lt > i) appendText(s.slice(i, lt))

    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt)
      if (e === -1) throw new Error('xml.ts: unterminated processing instruction')
      i = e + 2
    } else if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt)
      if (e === -1) throw new Error('xml.ts: unterminated comment')
      i = e + 3
    } else if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt)
      if (e === -1) throw new Error('xml.ts: unterminated CDATA section')
      // CDATA is character data, not parsed content: append verbatim.
      if (stack.length > 0) stack[stack.length - 1].text += s.slice(lt + 9, e)
      i = e + 3
    } else if (s.startsWith('<!', lt)) {
      // DOCTYPE / entity declarations — never emitted by DAV servers
      i = scanTagEnd(s, lt) + 1
    } else if (s.startsWith('</', lt)) {
      const e = s.indexOf('>', lt)
      if (e === -1) throw new Error('xml.ts: unterminated closing tag')
      const qname = s.slice(lt + 2, e).trim()
      const frame = stack.pop()
      if (!frame || frame.qname !== qname) {
        throw new Error(`xml.ts: mismatched closing tag </${qname}>`)
      }
      frame.node.text = frame.text
      if (stack.length > 0) stack[stack.length - 1].text += frame.text
      i = e + 1
    } else {
      const e = scanTagEnd(s, lt)
      const inner = s.slice(lt + 1, e)
      const selfClosing = inner.endsWith('/')
      const body = selfClosing ? inner.slice(0, -1) : inner
      const nameMatch = NAME_RE.exec(body)
      if (!nameMatch) throw new Error('xml.ts: malformed start tag')
      const qname = nameMatch[0]

      const attrs: Record<string, string> = {}
      const addScope: Record<string, string> = {}
      ATTR_RE.lastIndex = 0
      let am: RegExpExecArray | null
      while ((am = ATTR_RE.exec(body)) !== null) {
        const value = decodeEntities(am[2] ?? am[3] ?? '')
        if (am[1] === 'xmlns') addScope[''] = value
        else if (am[1].startsWith('xmlns:')) addScope[am[1].slice(6)] = value
        attrs[am[1]] = value
      }

      const colon = qname.indexOf(':')
      const prefix = colon === -1 ? '' : qname.slice(0, colon)
      const local = colon === -1 ? qname : qname.slice(colon + 1)
      const parentScope = stack.length > 0 ? stack[stack.length - 1].scope : {}
      // The element's own xmlns declarations apply to its own name too.
      const scope = { ...parentScope, ...addScope }
      const node: MutableXmlNode = {
        // Unbound prefix → fall back to the prefix string so lookups by
        // qname still work; DAV servers always declare their prefixes.
        ns: scope[prefix] ?? (prefix === '' ? '' : prefix),
        local,
        attrs,
        children: [],
        text: '',
      }
      if (stack.length === 0) root = node
      else stack[stack.length - 1].node.children.push(node)
      if (!selfClosing) stack.push({ qname, node, scope, text: '' })
      i = e + 1
    }
  }

  if (stack.length > 0) throw new Error(`xml.ts: unclosed element <${stack[stack.length - 1].qname}>`)
  if (!root) throw new Error('xml.ts: no root element')
  return root
}

/** First child matching namespace + local name, or null. */
function firstChild(node: XmlNode, ns: string, local: string): XmlNode | null {
  for (const c of node.children) {
    if (c.ns === ns && c.local === local) return c
  }
  return null
}

// ---------------------------------------------------------------------------
// Multistatus readers
// ---------------------------------------------------------------------------

export interface DavPropResponse {
  /** server path as emitted by the server */
  href: string
  props: Record<string, string>
  /** response-level `D:status` text, e.g. `HTTP/1.1 404 Not Found` (present
   *  on sync-deleted / multiget-missing entries that carry no propstat) */
  status?: string
}

/** String projection of one D:prop child (semantics in the module header). */
function propValue(prop: XmlNode): string {
  if (prop.children.length === 0) return prop.text.trim()
  if (prop.local === 'resourcetype') {
    return prop.children.map((k) => k.local).join(' ')
  }
  const hrefChild = firstChild(prop, NS.DAV, 'href')
  if (hrefChild) return hrefChild.text.trim()
  if (prop.local === 'supported-calendar-component-set') {
    const names: string[] = []
    for (const k of prop.children) {
      if (k.local === 'comp' && k.attrs['name']) names.push(k.attrs['name'])
    }
    return names.join(' ')
  }
  return prop.children.map((k) => k.local).join(' ')
}

/**
 * Parse a 207 multistatus body into flat `{href, props, status?}` records.
 * Namespace-aware (any prefix / default-ns document). Props listed under a
 * non-2xx propstat (Radicale's 404 "not found" branch) are omitted.
 */
export function parseMultistatus(xmlText: string): DavPropResponse[] {
  const root = parseXml(xmlText)
  if (root.ns !== NS.DAV || root.local !== 'multistatus') return []

  const out: DavPropResponse[] = []
  for (const resp of root.children) {
    if (resp.ns !== NS.DAV || resp.local !== 'response') continue
    const hrefEl = firstChild(resp, NS.DAV, 'href')
    const props: Record<string, string> = {}
    let status: string | undefined
    const statusEl = firstChild(resp, NS.DAV, 'status')
    if (statusEl) status = statusEl.text.trim()

    for (const ps of resp.children) {
      if (ps.ns !== NS.DAV || ps.local !== 'propstat') continue
      const psStatus = firstChild(ps, NS.DAV, 'status')?.text.trim() ?? ''
      if (psStatus && !/\b2\d\d\b/.test(psStatus)) continue // 404 branch → prop absent
      const propEl = firstChild(ps, NS.DAV, 'prop')
      if (!propEl) continue
      for (const p of propEl.children) props[p.local] = propValue(p)
    }
    out.push({ href: hrefEl ? hrefEl.text.trim() : '', props, ...(status ? { status } : {}) })
  }
  return out
}

/** `D:multistatus/D:sync-token` text, or null when absent/undecodable. */
export function parseSyncToken(xmlText: string): string | null {
  try {
    const root = parseXml(xmlText)
    const tok = firstChild(root, NS.DAV, 'sync-token')
    return tok ? tok.text.trim() : null
  } catch {
    return null
  }
}

/**
 * True when `xmlText` is a `D:error` body containing `D:valid-sync-token` —
 * Radicale's HTTP 403 "invalid or expired sync token" signal. Never throws,
 * so it can probe any error body.
 */
export function isSyncTokenError(xmlText: string): boolean {
  try {
    const root = parseXml(xmlText)
    if (root.ns !== NS.DAV || root.local !== 'error') return false
    for (const c of root.children) {
      if (c.ns === NS.DAV && c.local === 'valid-sync-token') return true
    }
    return false
  } catch {
    return false
  }
}
