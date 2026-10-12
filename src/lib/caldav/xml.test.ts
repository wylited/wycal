// caldav XML builder + multistatus parser tests (bun:test) — CONTRACTS.md §3 + §8.
//
// Zero network. The builders are asserted byte-for-byte against RFC 4791 /
// RFC 6578 / RFC 5689 body fixtures; `parseMultistatus` runs on Radicale-style
// 207 documents (propstat 200/404 branches, response-level 404 for sync-deleted
// entries, `D:sync-token`, `D:error/D:valid-sync-token` — the shapes verified
// in `radicale/app/report.py` per local://wycal-research.md §3).

import { describe, expect, it } from 'bun:test'
import {
  buildMkcolBody,
  buildMultigetBody,
  buildPropfindBody,
  buildSyncCollectionBody,
  isSyncTokenError,
  parseMultistatus,
  parseSyncToken,
  parseXml,
  xmlEscape,
} from './xml'

const XML_DECL = '<?xml version="1.0" encoding="utf-8" ?>'

/** Mirror of xml.ts's root namespace declaration — must match byte-for-byte. */
const NSD =
  ' xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"' +
  ' xmlns:CR="urn:ietf:params:xml:ns:carddav"' +
  ' xmlns:ICAL="http://apple.com/ns/ical/" xmlns:NK="http://nextcloud.com/ns"'

const j = (...lines: string[]): string => lines.join('\n')

describe('xml body builders (byte-stable fixtures)', () => {
  it('buildPropfindBody emits prop children in order', () => {
    const body = buildPropfindBody(['D:resourcetype', 'D:displayname'])
    expect(body).toBe(
      XML_DECL +
        '<D:propfind' + NSD + '>' +
        '<D:prop><D:resourcetype/><D:displayname/></D:prop>' +
        '</D:propfind>',
    )
    expect(buildPropfindBody(['D:getetag'])).toBe(buildPropfindBody(['D:getetag']))
  })

  it('buildPropfindBody rejects unknown prefixes', () => {
    expect(() => buildPropfindBody(['X:nope'])).toThrow(/unknown namespace prefix/)
  })

  it('buildSyncCollectionBody: empty token for initial sync, escaped token otherwise', () => {
    expect(buildSyncCollectionBody()).toBe(
      XML_DECL +
        '<D:sync-collection' + NSD + '>' +
        '<D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop>' +
        '</D:sync-collection>',
    )
    expect(buildSyncCollectionBody('http://radicale.org/ns/sync/abc&1')).toBe(
      XML_DECL +
        '<D:sync-collection' + NSD + '>' +
        '<D:sync-token>http://radicale.org/ns/sync/abc&amp;1</D:sync-token>' +
        '<D:sync-level>1</D:sync-level>' +
        '<D:prop><D:getetag/></D:prop>' +
        '</D:sync-collection>',
    )
  })

  it('buildMultigetBody: calendar flavor (RFC 4791 §7.9 request shape)', () => {
    expect(
      buildMultigetBody(['/demo/personal.ics/a.ics', '/demo/personal.ics/b.ics'], 'calendar'),
    ).toBe(
      XML_DECL +
        '<C:calendar-multiget' + NSD + '>' +
        '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
        '<D:href>/demo/personal.ics/a.ics</D:href>' +
        '<D:href>/demo/personal.ics/b.ics</D:href>' +
        '</C:calendar-multiget>',
    )
  })

  it('buildMultigetBody: addressbook flavor (RFC 6352 §8.7 request shape)', () => {
    expect(buildMultigetBody(['/demo/contacts/me.vcf'], 'addressbook')).toBe(
      XML_DECL +
        '<CR:addressbook-multiget' + NSD + '>' +
        '<D:prop><D:getetag/><CR:address-data/></D:prop>' +
        '<D:href>/demo/contacts/me.vcf</D:href>' +
        '</CR:addressbook-multiget>',
    )
  })

  it('buildMkcolBody: calendar defaults to VEVENT+VTODO, carries color', () => {
    expect(buildMkcolBody({ name: 'Personal', kind: 'calendar', color: '#fa8d3e' })).toBe(
      XML_DECL +
        '<D:mkcol' + NSD + '><D:set><D:prop>' +
        '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>' +
        '<D:displayname>Personal</D:displayname>' +
        '<ICAL:calendar-color>#fa8d3e</ICAL:calendar-color>' +
        '<C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>' +
        '</D:prop></D:set></D:mkcol>',
    )
  })

  it('buildMkcolBody: addressbook has no color/component-set; text is escaped', () => {
    expect(
      buildMkcolBody({ name: 'Team & Family "2"', kind: 'addressbook' }),
    ).toBe(
      XML_DECL +
        '<D:mkcol' + NSD + '><D:set><D:prop>' +
        '<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>' +
        '<D:displayname>Team &amp; Family &quot;2&quot;</D:displayname>' +
        '</D:prop></D:set></D:mkcol>',
    )
    expect(
      buildMkcolBody({ name: 'x', kind: 'calendar', components: ['VEVENT', 'VTODO'] }),
    ).toContain('<C:comp name="VEVENT"/><C:comp name="VTODO"/>')
  })

  it('xmlEscape covers the five metacharacters', () => {
    expect(xmlEscape('a<b>&"\'')).toBe('a&lt;b&gt;&amp;&quot;&apos;')
  })
})

// -- Radicale-style PROPFIND 207 ---------------------------------------------

const PROPfind_207 = j(
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"' +
    ' xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:ICAL="http://apple.com/ns/ical/">',
  '<D:response>',
  '<D:href>/demo/</D:href>',
  '<D:propstat><D:prop>',
  '<D:resourcetype><D:collection/></D:resourcetype>',
  '<D:displayname>demo</D:displayname>',
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '</D:response>',
  '<D:response>',
  '<D:href>/demo/personal.ics/</D:href>',
  '<D:propstat><D:prop>',
  '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>',
  '<D:displayname>personal</D:displayname>',
  '<ICAL:calendar-color>#fa8d3e</ICAL:calendar-color>',
  '<C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>',
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '<D:propstat><D:prop><D:getcontenttype/></D:prop>',
  '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>',
  '</D:response>',
  '<D:response>',
  '<D:href>/demo/contacts/</D:href>',
  '<D:propstat><D:prop>',
  '<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>',
  '<D:displayname>Contacts</D:displayname>',
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '</D:response>',
  '</D:multistatus>',
)

describe('parseMultistatus — Radicale-style PROPFIND 207', () => {
  const rs = parseMultistatus(PROPfind_207)

  it('returns one record per D:response with hrefs verbatim', () => {
    expect(rs).toHaveLength(3)
    expect(rs[0].href).toBe('/demo/')
    expect(rs[1].href).toBe('/demo/personal.ics/')
    expect(rs[2].href).toBe('/demo/contacts/')
  })

  it('projects 200-propstat props (resourcetype/displayname/color/component-set)', () => {
    expect(rs[0].props['resourcetype']).toBe('collection')
    expect(rs[0].props['displayname']).toBe('demo')
    expect(rs[1].props['resourcetype']).toBe('collection calendar')
    expect(rs[1].props['calendar-color']).toBe('#fa8d3e')
    expect(rs[1].props['supported-calendar-component-set']).toBe('VEVENT VTODO')
    expect(rs[2].props['resourcetype']).toBe('collection addressbook')
  })

  it('omits props from the 404 propstat branch and leaves response status unset', () => {
    expect('getcontenttype' in rs[1].props).toBe(false)
    expect(rs[1].status).toBeUndefined()
    expect(rs[0].status).toBeUndefined()
  })
})

// -- RFC 4791 §7.9.1 calendar-multiget 207 ------------------------------------

const MULTIGET_207 = j(
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
  '<D:response>',
  '<D:href>http://cal.example.com/bernard/work/abcd1.ics</D:href>',
  '<D:propstat><D:prop>',
  '<D:getetag>"fffff-abcd1"</D:getetag>',
  '<C:calendar-data>BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'SUMMARY:Event #1',
  'END:VEVENT',
  'END:VCALENDAR</C:calendar-data>',
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '</D:response>',
  '<D:response>',
  '<D:href>http://cal.example.com/bernard/work/mtg1.ics</D:href>',
  '<D:status>HTTP/1.1 404 Not Found</D:status>',
  '</D:response>',
  '</D:multistatus>',
)

describe('parseMultistatus — RFC 4791 §7.9.1 multiget 207', () => {
  const rs = parseMultistatus(MULTIGET_207)

  it('returns quoted etag + multiline calendar-data verbatim (trimmed)', () => {
    expect(rs[0].href).toBe('http://cal.example.com/bernard/work/abcd1.ics')
    expect(rs[0].props['getetag']).toBe('"fffff-abcd1"')
    expect(rs[0].props['calendar-data']).toBe(
      'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Event #1\nEND:VEVENT\nEND:VCALENDAR',
    )
  })

  it('reports missing objects as response-level 404 with no props', () => {
    expect(rs[1].href).toBe('http://cal.example.com/bernard/work/mtg1.ics')
    expect(rs[1].status).toBe('HTTP/1.1 404 Not Found')
    expect(Object.keys(rs[1].props)).toHaveLength(0)
  })
})

// -- Radicale sync-collection 207 + token -------------------------------------

const SYNC_207 = j(
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<D:multistatus xmlns:D="DAV:">',
  '<D:response>',
  '<D:href>/demo/personal.ics/ev1.ics</D:href>',
  '<D:propstat><D:prop><D:getetag>"a1b2c3"</D:getetag></D:prop>',
  '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '</D:response>',
  '<D:response>',
  '<D:href>/demo/personal.ics/gone.ics</D:href>',
  '<D:status>HTTP/1.1 404 Not Found</D:status>',
  '</D:response>',
  '<D:sync-token>http://radicale.org/ns/sync/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef</D:sync-token>',
  '</D:multistatus>',
)

describe('sync-collection 207 parsing', () => {
  const rs = parseMultistatus(SYNC_207)

  it('changed entries carry getetag and no response status', () => {
    expect(rs[0].props['getetag']).toBe('"a1b2c3"')
    expect(rs[0].status).toBeUndefined()
  })

  it('deleted entries are bare 404-status responses', () => {
    expect(rs[1].status).toBe('HTTP/1.1 404 Not Found')
    expect(Object.keys(rs[1].props)).toHaveLength(0)
  })

  it('extracts the D:sync-token; null when absent', () => {
    expect(parseSyncToken(SYNC_207)).toBe(
      'http://radicale.org/ns/sync/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    expect(parseSyncToken(PROPfind_207)).toBeNull()
  })
})

// -- D:error bodies ------------------------------------------------------------

const VALID_SYNC_TOKEN_403 =
  XML_DECL + '\n<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>'

describe('Radicale error bodies (never throw)', () => {
  it('detects D:error/D:valid-sync-token (HTTP 403 invalid-token signal)', () => {
    expect(isSyncTokenError(VALID_SYNC_TOKEN_403)).toBe(true)
    expect(parseSyncToken(VALID_SYNC_TOKEN_403)).toBeNull()
  })

  it('rejects other error bodies and garbage', () => {
    expect(
      isSyncTokenError(
        '<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:supported-filter/></D:error>',
      ),
    ).toBe(false)
    expect(isSyncTokenError('')).toBe(false)
    expect(isSyncTokenError('not xml at all')).toBe(false)
    expect(parseSyncToken('')).toBeNull()
  })
})

// -- namespace + entity edge cases ---------------------------------------------

const DEFAULT_NS_207 = j(
  '<multistatus xmlns="DAV:">',
  '<response><href>/demo/w%20eird%26x.ics</href>',
  '<propstat><prop>',
  '<getetag>&#34;num&#34;</getetag>',
  '<displayname>Café &amp; crème</displayname>',
  '</prop><status>HTTP/1.1 200 OK</status></propstat>',
  '</response>',
  '</multistatus>',
)

describe('parser edge cases', () => {
  it('parses default-namespace documents, keeps percent-encoding, decodes entities', () => {
    const [r] = parseMultistatus(DEFAULT_NS_207)
    expect(r.href).toBe('/demo/w%20eird%26x.ics')
    expect(r.props['getetag']).toBe('"num"')
    expect(r.props['displayname']).toBe('Café & crème')
  })

  it('returns [] for non-multistatus roots', () => {
    expect(parseMultistatus(VALID_SYNC_TOKEN_403)).toEqual([])
    expect(parseMultistatus('<foo/>')).toEqual([])
  })

  it('parseXml throws on malformed input', () => {
    expect(() => parseXml('<D:multistatus></D:other>')).toThrow()
    expect(() => parseXml('<D:a>')).toThrow()
  })

  it('passes CDATA content through literally (no entity decode)', () => {
    const [r] = parseMultistatus(
      j(
        '<D:multistatus xmlns:D="DAV:">',
        '<D:response><D:href>/demo/x.ics</D:href>',
        '<D:propstat><D:prop>',
        '<D:getetag><![CDATA["abc&amp;def"]]></D:getetag>',
        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
        '</D:response>',
        '</D:multistatus>',
      ),
    )
    expect(r.props['getetag']).toBe('"abc&amp;def"')
  })
})

// -- Radicale-shaped 207: default xmlns, 2-space indent, entity-encoded CRLF --

// Radicale emits default-namespace documents with indentation, and
// `C:calendar-data` whose CRLF line endings are entity-encoded as `&#13;`
// (CR is not allowed bare in XML; LF is).
const RADICALE_207 = j(
  '<?xml version="1.0" encoding="utf-8"?>',
  '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
  '  <response>',
  '    <href>/demo/personal.ics/ev1.ics</href>',
  '    <propstat>',
  '      <prop>',
  '        <getetag>"a1b2c3"</getetag>',
  '        <C:calendar-data>BEGIN:VCALENDAR&#13;',
  'VERSION:2.0&#13;',
  'BEGIN:VEVENT&#13;',
  'SUMMARY:A &amp; B &lt;test&gt;&#13;',
  'END:VEVENT&#13;',
  'END:VCALENDAR&#13;',
  '        </C:calendar-data>',
  '      </prop>',
  '      <status>HTTP/1.1 200 OK</status>',
  '    </propstat>',
  '  </response>',
  '</multistatus>',
)

describe('parseMultistatus — Radicale-shaped 207 (default ns, indented, CRLF entities)', () => {
  const rs = parseMultistatus(RADICALE_207)

  it('decodes &#13; to CR and metacharacter entities in calendar-data', () => {
    expect(rs[0].props['calendar-data']).toBe(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:A & B <test>\r\nEND:VEVENT\r\nEND:VCALENDAR',
    )
    expect(rs[0].props['getetag']).toBe('"a1b2c3"')
    expect(rs[0].href).toBe('/demo/personal.ics/ev1.ics')
  })
})

// -- nested D:href projection (principal / home-set props) ---------------------

const HOMES_207 = j(
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"' +
    ' xmlns:CR="urn:ietf:params:xml:ns:carddav">',
  '<D:response>',
  '<D:href>/</D:href>',
  '<D:propstat><D:prop>',
  '<D:current-user-principal><D:href>/demo/</D:href></D:current-user-principal>',
  '<C:calendar-home-set><D:href>/demo/</D:href></C:calendar-home-set>',
  '<CR:addressbook-home-set><D:href>/demo/</D:href></CR:addressbook-home-set>',
  '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
  '</D:response>',
  '</D:multistatus>',
)

describe('parseMultistatus — nested D:href projection', () => {
  it('projects current-user-principal and home-set props to inner href text', () => {
    const [r] = parseMultistatus(HOMES_207)
    expect(r.props['current-user-principal']).toBe('/demo/')
    expect(r.props['calendar-home-set']).toBe('/demo/')
    expect(r.props['addressbook-home-set']).toBe('/demo/')
  })
})
