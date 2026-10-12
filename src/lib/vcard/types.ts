// Contact model — frozen data-layer contract (CONTRACTS.md §3).
//
// One `Vcard` corresponds to one VCARD component. PHOTO values are normalized
// to URIs (`data:<mediatype>;base64,<payload>` for images); property lines the
// app does not model are kept verbatim in `raw` so they survive Radicale
// round-trips.

export interface Vcard {
  uid: string;
  /** Display name; required by vCard — derived from N (then ORG) when absent. */
  fn: string;
  /** Structured N value (family;given;middle;prefix;suffix), each part unescaped. */
  names?: {
    family: string;
    given: string;
    middle?: string;
    prefix?: string;
    suffix?: string;
  };
  emails: { value: string; types: string[] }[];
  tels: { value: string; types: string[] }[];
  /** ORG components, each unescaped, joined with ';'. */
  org?: string;
  title?: string;
  note?: string;
  /**
   * Birthday as written in the card: `YYYY-MM-DD`, `--MM-DD` (year unknown),
   * or a TEXT value, unescaped; re-emitted verbatim on serialize.
   */
  bday?: string;
  /** PHOTO as a URI; images use `data:<mediatype>;base64,<payload>`. */
  photo?: string;
  /**
   * ADR structured components (pobox;extended;street;locality;region;postal;
   * country), each unescaped, joined with ';'; trailing empty components are
   * trimmed so `split(';')` on serialize reproduces the original positions.
   */
  addresses: { value: string; types: string[] }[];
  /** REV timestamp string as it appeared in the source card. */
  rev?: string;
  /** Unknown property lines (unfolded, verbatim, '\n'-joined), re-emitted on serialize. */
  raw: string;
}
