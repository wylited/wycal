/**
 * WebDAV / CalDAV / CardDAV data-layer types — CONTRACTS.md §3 (frozen).
 *
 * URL law used across `lib/caldav`:
 * - `DavAccount.url` is the full origin including the same-origin `/dav`
 *   proxy prefix, e.g. `http://127.0.0.1:5173/dav`. The Vite proxy rewrites
 *   the prefix away, so Radicale itself stays prefix-free. The URL is
 *   identity/display only: `CaldavClient` routes every request through the
 *   PAGE's own origin + `/dav` when the account URL carries the proxy path,
 *   so localhost / 127.0.0.1 / lan-ip / hostname pages all stay same-origin.
 * - Secrets are session-scoped (CONTRACTS §4): `password` holds the secret
 *   resolvable in THIS tab ('' when none); `needsPassword` is derived, never
 *   persisted, and true when the user must unlock the account again.
 * - Every href the server hands back (principal URL, home sets, object
 *   hrefs in sync-collection / multiget responses) is a SERVER-ABSOLUTE
 *   PATH exactly as emitted (percent-encoded, no origin, no `/dav`),
 *   e.g. `/demo/personal.ics/abc.ics`. Hrefs are opaque tokens: pass them
 *   back verbatim — never re-encode, decode or append origins at call
 *   sites. `CaldavClient` normalizes and joins internally.
 * - `DavCollection.url` is the joined FULL URL (origin + prefix + server
 *   path) so stores can key collections by it.
 */

export interface DavAccount {
  id: string
  /** origin + /dav prefix, e.g. http://127.0.0.1:5173/dav (identity only) */
  url: string
  username: string
  /** Secret resolvable in this tab ('' = none — see needsPassword). */
  password: string
  /** Opt-in: persist the secret (plain text) in localStorage on this device. */
  rememberPassword: boolean
  /** Derived, never persisted: no usable secret in this tab → needs Unlock. */
  needsPassword: boolean
}

type DavCollectionKind = 'calendar' | 'addressbook'

export type DavComponent = 'VEVENT' | 'VTODO' | 'VCARD'

export interface DavCollection {
  /** full URL (origin + /dav prefix + server path) */
  url: string
  name: string
  color?: string
  kind: DavCollectionKind
  components: DavComponent[]
  etag?: string
}

export interface SyncResult {
  token: string
  /** server paths of objects that are new or changed since the token */
  changedHrefs: string[]
  /** server paths of objects deleted since the token */
  deletedHrefs: string[]
}

export interface DavObject {
  /** server path, as returned by the server */
  href: string
  etag: string
  /** raw iCalendar / vCard text */
  data: string
}

/** Machine-readable failure causes on {@link DavError}. */
type DavErrorCode = 'invalid-sync-token'

/**
 * Thrown for every non-2xx WebDAV response (and network-level failures).
 *
 * Radicale quirk law (local://wycal-research.md §3): an invalid or expired
 * sync token is reported as HTTP 403 with a `D:valid-sync-token` error body
 * (deliberately not 409). That case is flagged via
 * `code: 'invalid-sync-token'` — see {@link isInvalidSyncTokenError} — so
 * callers drop their stored token and run a full initial resync instead of
 * surfacing a fatal error.
 */
export class DavError extends Error {
  readonly status?: number
  readonly body?: string
  readonly code?: DavErrorCode

  constructor(
    message: string,
    opts: { status?: number; body?: string; code?: DavErrorCode } = {},
  ) {
    super(message)
    this.name = 'DavError'
    this.status = opts.status
    this.body = opts.body
    this.code = opts.code
  }
}

/** True when `e` is the Radicale 403-with-`D:valid-sync-token` resync signal. */
export function isInvalidSyncTokenError(e: unknown): e is DavError {
  return e instanceof DavError && e.code === 'invalid-sync-token'
}
