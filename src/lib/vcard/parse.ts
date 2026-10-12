// vCard parser — CONTRACTS.md §3 `parseVcf(text: string): Vcard[]`.
//
// Tolerates vCard 3.0 and 4.0 (plus 2.1-style bare TYPE tokens, 2.1
// QUOTED-PRINTABLE values with '=' soft breaks, and no-fold base64 PHOTO
// payloads). Radicale normalizes cards through vobject, which escapes
// TEXT-ish values, so a PHOTO data URI comes back as
//   `PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\;base64\,iVBORw0…`
// Unfolding + unescaping recovers the exact `data:image/png;base64,…` string.

import { deriveFn, splitUnescaped } from './text';
import type { Vcard } from './types';

/** One parsed content line: `[group.]NAME;PARAM=value:value`. */
interface VProp {
  name: string; // uppercased property name, group prefix stripped
  params: Map<string, string[]>; // uppercased param name → unquoted values
  value: string; // raw value, still escaped
}

/**
 * Unfold (RFC 6350 §3.2) plus two vCard 2.1 continuations:
 * - QUOTED-PRINTABLE soft breaks: a QP-encoded line ending in '=' is joined
 *   with the next physical line (the trailing '=' dropped) before '=XX'
 *   escapes are decoded later.
 * - No-fold base64 (PHOTO;ENCODING=BASE64): bare colon-less physical lines
 *   accumulate onto the pending value so the payload is not truncated.
 */
function unfold(text: string): string[] {
  const normalized = text
    .replace(/^\uFEFF/, '') // strip a leading UTF-8 BOM before line splitting
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines: string[] = [];
  let qpSoft = false; // last line is QP-encoded and ended with '='
  let b64Value = false; // last line carries a base64 value (PHOTO/ENCODING=BASE64)
  for (const raw of normalized.split('\n')) {
    const last = lines.length - 1;
    if (raw === '') {
      lines.push(raw);
      qpSoft = false; // blank line terminates any pending continuation
      b64Value = false;
      continue;
    }
    if (last >= 0 && qpSoft) {
      lines[last] = lines[last]!.slice(0, -1) + raw; // drop the soft-break '=' and join
    } else if (last >= 0 && b64Value && !raw.includes(':')) {
      // Base64 alphabet never starts with space/tab, so a leading fold char is
      // always RFC folding — drop it; bare 2.1 no-fold lines append verbatim.
      lines[last] += raw.startsWith(' ') || raw.startsWith('\t') ? raw.slice(1) : raw;
    } else if (last >= 0 && (raw.startsWith(' ') || raw.startsWith('\t'))) {
      lines[last] += raw.slice(1);
    } else {
      lines.push(raw);
    }
    const merged = lines[lines.length - 1]!;
    const prop = parseLine(merged);
    const encoding = (prop?.params.get('ENCODING') ?? []).join(',').toLowerCase();
    qpSoft = prop !== null && encoding.includes('quoted-printable') && merged.endsWith('=');
    b64Value = prop !== null && (prop.name === 'PHOTO' || encoding.includes('base64') || encoding === 'b');
  }
  return lines;
}

/** Unescape a TEXT-ish value: `\\ \; \, \n \N`; unknown escapes lose the backslash. */
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\' || i + 1 >= value.length) {
      out += ch;
      continue;
    }
    const next = value[++i];
    out += next === 'n' || next === 'N' ? '\n' : next;
  }
  return out;
}

const utf8Decoder = new TextDecoder();

/**
 * vCard 2.1 QUOTED-PRINTABLE decode of '=XX' hex escapes (soft breaks were
 * already joined during unfold). Bytes pass through a UTF-8 decode so
 * multi-byte escapes (=C3=A1) reassemble correctly.
 */
function qpDecode(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

/** QP-decode a property value when its ENCODING param says QUOTED-PRINTABLE. */
function maybeQpDecode(value: string, params: Map<string, string[]>): string {
  const encoding = (params.get('ENCODING') ?? []).join(',').toLowerCase();
  return encoding.includes('quoted-printable') ? qpDecode(value) : value;
}

/** Property value → text: QP-decode (vCard 2.1), then TEXT-unescape. */
function propValue(prop: VProp): string {
  return unescapeText(maybeQpDecode(prop.value, prop.params));
}

/** Split a parameter value on top-level commas, dropping quotes. */
function splitParamValues(raw: string): string[] {
  const values: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      values.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  values.push(cur.trim());
  return values.filter((v) => v !== '');
}

/** Parse one content line; returns null for lines without an unquoted `:`. */
function parseLine(line: string): VProp | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;

  const segments: string[] = [];
  let cur = '';
  quoted = false;
  for (const ch of line.slice(0, colon)) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  segments.push(cur);

  const token = segments[0] ?? '';
  const dot = token.indexOf('.');
  const name = (dot >= 0 ? token.slice(dot + 1) : token).trim().toUpperCase();
  if (name === '') return null;

  const params = new Map<string, string[]>();
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq < 0) {
      // vCard 2.1-style bare parameter token; treat it as a TYPE value.
      const values = splitParamValues(seg);
      if (values.length > 0) params.set('TYPE', [...(params.get('TYPE') ?? []), ...values]);
      continue;
    }
    const key = seg.slice(0, eq).trim().toUpperCase();
    params.set(key, [...(params.get(key) ?? []), ...splitParamValues(seg.slice(eq + 1).trim())]);
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** TYPE/PREF params → normalized lowercase type list; 'pref' is kept as a type. */
function typesOf(params: Map<string, string[]>): string[] {
  const types: string[] = [];
  const add = (t: string): void => {
    const key = t.trim().toLowerCase();
    if (key !== '' && !types.includes(key)) types.push(key);
  };
  for (const t of params.get('TYPE') ?? []) add(t);
  if (params.has('PREF')) add('pref'); // vCard 4.0 PREF=n → keep as a 'pref' type
  return types;
}

function parseN(value: string): NonNullable<Vcard['names']> {
  const parts = splitUnescaped(value, ';').map(unescapeText);
  const at = (i: number): string => parts[i] ?? '';
  return { family: at(0), given: at(1), middle: at(2), prefix: at(3), suffix: at(4) };
}

function parseAddress(
  params: Map<string, string[]>,
  value: string,
): { value: string; types: string[] } {
  const parts = splitUnescaped(value, ';').map(unescapeText);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return { value: parts.join(';'), types: typesOf(params) };
}

/** vCard 3.0 PHOTO TYPE values → MIME media types. */
const PHOTO_TYPE_MEDIA: Record<string, string> = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  JPG: 'image/jpeg',
  JPE: 'image/jpeg',
  GIF: 'image/gif',
  BMP: 'image/bmp',
  WEBP: 'image/webp',
};

/** Media type for a bare-base64 PHOTO: MEDIATYPE param, then TYPE, then RFC 2426 default. */
function photoMediaType(params: Map<string, string[]>): string {
  const media = params.get('MEDIATYPE')?.[0];
  if (media !== undefined && media.trim() !== '') return media.trim().toLowerCase();
  for (const t of params.get('TYPE') ?? []) {
    const mediaType = PHOTO_TYPE_MEDIA[t.trim().toUpperCase()];
    if (mediaType !== undefined) return mediaType;
  }
  return 'image/jpeg';
}

/** PHOTO → URI. Bare base64 (3.0 `ENCODING=b`) is wrapped as a data URI. */
function parsePhoto(params: Map<string, string[]>, value: string): string {
  const uri = unescapeText(value).trim();
  const lower = uri.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('https://') || lower.startsWith('http://')) {
    return uri;
  }
  const encoding = (params.get('ENCODING') ?? []).join(',').toLowerCase();
  const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(uri);
  if (encoding === 'b' || encoding === 'base64' || looksBase64) {
    return `data:${photoMediaType(params)};base64,${uri.replace(/\s+/g, '')}`;
  }
  return uri;
}

/** Parse a vCard stream into models. Properties outside BEGIN/END blocks are ignored. */
export function parseVcf(text: string): Vcard[] {
  const cards: Vcard[] = [];
  let card: Vcard | null = null;
  let rawLines: string[] = [];

  const finish = (): void => {
    if (!card) return;
    card.raw = rawLines.join('\n');
    if (card.fn.trim() === '') card.fn = deriveFn(card.names, card.org);
    cards.push(card);
    card = null;
    rawLines = [];
  };

  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      finish();
      card = { uid: '', fn: '', emails: [], tels: [], addresses: [], categories: [], raw: '' };
      continue;
    }
    if (prop.name === 'END') {
      finish();
      continue;
    }
    if (!card || prop.name === 'VERSION') continue;

    switch (prop.name) {
      case 'UID':
        card.uid = propValue(prop);
        break;
      case 'FN':
        card.fn = propValue(prop);
        break;
      case 'N':
        card.names = parseN(maybeQpDecode(prop.value, prop.params));
        break;
      case 'EMAIL':
        card.emails.push({ value: propValue(prop), types: typesOf(prop.params) });
        break;
      case 'TEL':
        card.tels.push({ value: propValue(prop), types: typesOf(prop.params) });
        break;
      case 'ADR':
        card.addresses.push(parseAddress(prop.params, maybeQpDecode(prop.value, prop.params)));
        break;
      case 'ORG': {
        const org = splitUnescaped(maybeQpDecode(prop.value, prop.params), ';').map(unescapeText).join(';');
        if (org !== '') card.org = org;
        break;
      }
      case 'TITLE':
        if (prop.value !== '') card.title = propValue(prop);
        break;
      case 'NOTE': {
        const note = propValue(prop);
        card.note = card.note === undefined ? note : `${card.note}\n${note}`;
        break;
      }
      case 'BDAY': {
        // Full `YYYY-MM-DD`, partial `--MM-DD`, or TEXT — kept as written
        // (unescaped); the engine materializes yearly events from it (§13).
        const bday = propValue(prop).trim();
        if (bday !== '') card.bday = bday;
        break;
      }
      case 'CATEGORIES': {
        // Comma list, text-unescaped; multiple CATEGORIES lines merge (same
        // rule as VEVENT/VTODO CATEGORIES in lib/ics). Modeled here — never
        // raw — so serialize emits exactly one line and edits cannot duplicate.
        for (const c of splitUnescaped(maybeQpDecode(prop.value, prop.params), ',').map(unescapeText)) {
          if (c !== '') card.categories.push(c);
        }
        break;
      }
      case 'REV':
        card.rev = propValue(prop);
        break;
      case 'PHOTO':
        card.photo = parsePhoto(prop.params, maybeQpDecode(prop.value, prop.params));
        break;
      default:
        rawLines.push(line); // unknown property — re-emitted verbatim on serialize
    }
  }
  finish(); // tolerate a missing END:VCARD
  return cards;
}
