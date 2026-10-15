// Shared TEXT-value helpers — single source for the parser/serializer
// conventions on structured `;`-joined values (N, ADR, ORG) and the FN
// display-name fallback, so both sides stay byte-compatible.

import type { Vcard } from './types';

/** Split on `sep` occurrences that are not backslash-escaped. */
export function splitUnescaped(value: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[++i];
    } else if (ch === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** FN fallback: display form of N, else ORG. */
export function deriveFn(names: Vcard['names'], org?: string): string {
  if (names) {
    const fn = [names.prefix, names.given, names.middle, names.family, names.suffix]
      .map((part) => part ?? '')
      .filter((part) => part.trim() !== '')
      .join(' ')
      .trim();
    if (fn !== '') return fn;
  }
  return org ?? '';
}
