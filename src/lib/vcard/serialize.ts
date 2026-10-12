// vCard serializer — CONTRACTS.md §3 `serializeVcard(v: Vcard): string`.
//
// Always emits vCard 4.0 (VERSION bumped), CRLF endings, lines folded at 75
// octets. TEXT-ish values are escaped exactly the way vobject/Radicale expects
// (`\\ \; \, \n`) so escaped PHOTO data URIs survive server round-trips.
// REV is refreshed to "now" on every write; unknown properties kept in
// `raw` are re-emitted verbatim.

import { deriveFn, splitUnescaped } from './text';
import type { Vcard } from './types';

const FOLD_LIMIT = 75; // RFC 6350 §3.2: content lines SHOULD be ≤ 75 octets
const ADR_COMPONENTS = 7; // pobox;extended;street;locality;region;postal;country

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Escape a TEXT-ish value: `\` → `\\`, then `;` `,`, then newlines → `\n`. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line at FOLD_LIMIT octets without splitting UTF-8 characters. */
function foldLine(line: string): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= FOLD_LIMIT) return line;
  const chunks: string[] = [];
  let start = 0;
  let limit = FOLD_LIMIT; // continuation lines spend 1 octet on the leading space
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    if (end < bytes.length) {
      while (end > start && (bytes[end] & 0xc0) === 0x80) end--; // back up to a lead byte
    }
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = FOLD_LIMIT - 1;
  }
  return chunks.join('\r\n ');
}

/** REV value: RFC 6350 timestamp, second precision, UTC. */
function revNow(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/** EMAIL/TEL-style property with an optional combined TYPE parameter. */
function typedProp(name: string, entry: { value: string; types: string[] }): string {
  const params = entry.types.length > 0 ? `;TYPE=${entry.types.map(escapeText).join(',')}` : '';
  return `${name}${params}:${escapeText(entry.value)}`;
}

/** ADR property: the flat `value` is split back into 7 components and re-escaped. */
function adrProp(entry: { value: string; types: string[] }): string {
  const parts = splitUnescaped(entry.value, ';');
  while (parts.length < ADR_COMPONENTS) parts.push('');
  const params = entry.types.length > 0 ? `;TYPE=${entry.types.map(escapeText).join(',')}` : '';
  return `ADR${params}:${parts.slice(0, ADR_COMPONENTS).map(escapeText).join(';')}`;
}

/** PHOTO property. Data URIs carry VALUE=uri + MEDIATYPE, mirroring Radicale's form. */
function photoProp(uri: string): string {
  const match = /^data:([^;,]*)(;base64)?,/i.exec(uri);
  if (match) {
    const mediaType = match[1] !== '' ? match[1] : 'application/octet-stream';
    return `PHOTO;VALUE=uri;MEDIATYPE=${mediaType}:${escapeText(uri)}`;
  }
  return `PHOTO;VALUE=uri:${escapeText(uri)}`;
}

/** Serialize one vCard as VERSION:4.0 with CRLF endings, folded at 75 octets. */
export function serializeVcard(v: Vcard): string {
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:4.0'];
  lines.push(`UID:${escapeText(v.uid)}`);

  const fn = v.fn.trim() !== '' ? v.fn.trim() : deriveFn(v.names, v.org);
  lines.push(`FN:${escapeText(fn)}`);

  const n = v.names ?? { family: '', given: '' };
  const nParts = [n.family, n.given, n.middle, n.prefix, n.suffix].map((part) =>
    escapeText(part ?? ''),
  );
  lines.push(`N:${nParts.join(';')}`);

  if (v.org !== undefined && v.org !== '') {
    // Component-preserving: escape each ';'-separated ORG component, then join,
    // so `Example Corp;Design` re-serializes as `ORG:Example Corp;Design`.
    lines.push(`ORG:${v.org.split(';').map(escapeText).join(';')}`);
  }
  if (v.title !== undefined && v.title !== '') lines.push(`TITLE:${escapeText(v.title)}`);
  if (v.bday !== undefined && v.bday !== '') lines.push(`BDAY:${escapeText(v.bday)}`);
  if (v.photo !== undefined && v.photo !== '') lines.push(photoProp(v.photo));

  for (const email of v.emails) {
    if (email.value !== '') lines.push(typedProp('EMAIL', email));
  }
  for (const tel of v.tels) {
    if (tel.value !== '') lines.push(typedProp('TEL', tel));
  }
  for (const address of v.addresses) {
    if (address.value !== '') lines.push(adrProp(address));
  }

  if (v.note !== undefined && v.note !== '') lines.push(`NOTE:${escapeText(v.note)}`);
  lines.push(`REV:${revNow()}`);

  if (v.raw !== '') {
    for (const line of v.raw.split(/\r?\n/)) {
      if (line !== '') lines.push(line); // unknown properties, verbatim
    }
  }

  lines.push('END:VCARD');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
