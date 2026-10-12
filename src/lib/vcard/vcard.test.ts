// vcard round-trip tests (bun:test) — CONTRACTS.md §3 + §8.
//
// Key fixture: Radicale normalizes vcards through vobject, which escapes
// TEXT-ish values, so a PHOTO data URI comes back as
//   PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\;base64\,iVBORw0…
// The parser must recover the exact `data:image/png;base64,…` string and the
// serializer must re-escape identically so server round-trips are stable.

import { describe, expect, it, setSystemTime } from 'bun:test';
import { parseVcf } from './parse';
import { serializeVcard } from './serialize';
import type { Vcard } from './types';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PHOTO_VCF = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:photo-1',
  'FN:Photo Person',
  `PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\\;base64\\,${PNG_BASE64}`,
  'END:VCARD',
].join('\r\n');

const PHOTO_V30 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:photo-2',
  'FN:Legacy Photo',
  'PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgoAAAANSUhEUg==',
  'END:VCARD',
].join('\r\n');

const MULTI_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:multi-1',
  'FN:Multi Value',
  'N:Value;Multi;;;',
  'EMAIL;type=HOME,pref:home@example.com',
  'EMAIL;TYPE=work:Work@Example.COM',
  'TEL;type=CELL:+1-555-0100',
  'TEL;TYPE=home,voice:+1-555-0101',
  'ADR;type=home:;;123 Main St;Springfield;IL;62704;USA',
  'ADR;TYPE=work:;;9 Work Park;Shelbyville;IL;62565;USA',
  'END:VCARD',
].join('\r\n');

const UNICODE_VCF = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:uni-1',
  'N:Doe\\; Jr;José;;Dr.;PhD',
  'FN:Dr. José Doe\\; Jr PhD',
  'NOTE:first\\nsecond\\\\path\\,comma\\;semi',
  'END:VCARD',
].join('\r\n');

const LEGACY_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:legacy-1',
  'FN:Legacy Contact',
  'N:Contact;Legacy;;;',
  'REV:2001-02-03T04:05:06Z',
  'END:VCARD',
].join('\r\n');

const GROUP_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:grp-1',
  'FN:Group Test',
  'item1.TEL;type=CELL:+1-555-0100',
  'item2.EMAIL;type=HOME:home@example.com',
  'item3.ADR;type=home:;;1 A St;Town;CA;90210;US',
  'ITEM4.TEL;type=work:+1-555-0200',
  'END:VCARD',
].join('\r\n');

const RAW_VCF = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:raw-1',
  'FN:Raw Keep',
  'X-MOOD:happy',
  'URL:https://example.com/~u?a=1;b=2',
  'END:VCARD',
].join('\r\n');

const BDAY_VCF = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:bday-1',
  'FN:Bday Person',
  'BDAY:1980-04-06',
  'END:VCARD',
].join('\r\n');

const BDAY_PARTIAL_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:bday-2',
  'FN:Partial Bday',
  'BDAY:--04-06',
  'END:VCARD',
].join('\r\n');

const FIXTURES = [PHOTO_VCF, PHOTO_V30, MULTI_VCF, UNICODE_VCF, LEGACY_VCF, GROUP_VCF, RAW_VCF, BDAY_VCF, BDAY_PARTIAL_VCF];

/** serialize(parse(x)) must equal serialize(parse(serialize(parse(x)))). */
function expectRoundTripStable(vcf: string): void {
  const once = serializeVcard(parseVcf(vcf)[0]!);
  const twice = serializeVcard(parseVcf(once)[0]!);
  expect(twice).toBe(once);
}

describe('parseVcf — Radicale PHOTO normalization', () => {
  it('unfolds and unescapes the vobject-escaped data URI exactly', () => {
    const [card] = parseVcf(PHOTO_VCF);
    expect(card!.photo).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it('recovers a data URI from an unescaped PHOTO too', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:photo-3',
      'FN:Plain Photo',
      `PHOTO:data:image/png;base64,${PNG_BASE64}`,
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcf(vcf)[0]!.photo).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it('re-escapes PHOTO the same way Radicale does', () => {
    const escapedLine = `PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\\;base64\\,${PNG_BASE64}`;
    const out = serializeVcard(parseVcf(PHOTO_VCF)[0]!);
    expect(out.replace(/\r\n /g, '')).toContain(escapedLine);
    expect(parseVcf(out)[0]!.photo).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it('wraps vCard 3.0 bare base64 PHOTO as a data URI', () => {
    const [card] = parseVcf(PHOTO_V30);
    expect(card!.photo).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    const out = serializeVcard(card!);
    expect(out.replace(/\r\n /g, '')).toContain(
      'PHOTO;VALUE=uri;MEDIATYPE=image/png:data:image/png\\;base64\\,iVBORw0KGgoAAAANSUhEUg==',
    );
  });
});

describe('parseVcf — multi-value EMAIL/TEL/ADR', () => {
  it('parses every value with case-insensitive types, keeping pref', () => {
    const [card] = parseVcf(MULTI_VCF);
    expect(card!.emails).toEqual([
      { value: 'home@example.com', types: ['home', 'pref'] },
      { value: 'Work@Example.COM', types: ['work'] },
    ]);
    expect(card!.tels).toEqual([
      { value: '+1-555-0100', types: ['cell'] },
      { value: '+1-555-0101', types: ['home', 'voice'] },
    ]);
    expect(card!.addresses).toEqual([
      { value: ';;123 Main St;Springfield;IL;62704;USA', types: ['home'] },
      { value: ';;9 Work Park;Shelbyville;IL;62565;USA', types: ['work'] },
    ]);
  });

  it('serializes all entries with TYPE params and stable ordering', () => {
    const out = serializeVcard(parseVcf(MULTI_VCF)[0]!);
    expect(out).toContain('EMAIL;TYPE=home,pref:home@example.com');
    expect(out).toContain('EMAIL;TYPE=work:Work@Example.COM');
    expect(out).toContain('TEL;TYPE=cell:+1-555-0100');
    expect(out).toContain('TEL;TYPE=home,voice:+1-555-0101');
    expect(out).toContain('ADR;TYPE=home:;;123 Main St;Springfield;IL;62704;USA');
    expect(out).toContain('ADR;TYPE=work:;;9 Work Park;Shelbyville;IL;62565;USA');
  });

  it('treats vCard 4.0 PREF=n as a pref type', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:pref-1',
      'FN:Pref Test',
      'TEL;PREF=1;TYPE=cell:+1-555-0100',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcf(vcf)[0]!.tels).toEqual([{ value: '+1-555-0100', types: ['cell', 'pref'] }]);
  });

  it('accumulates repeated TYPE params instead of overwriting', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:type-1',
      'FN:Repeat Type',
      'TEL;TYPE=cell;TYPE=voice:+1-555',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcf(vcf)[0]!.tels).toEqual([{ value: '+1-555', types: ['cell', 'voice'] }]);
  });
});

describe('N / FN structured values', () => {
  it('parses unicode names and escaped components', () => {
    const [card] = parseVcf(UNICODE_VCF);
    expect(card!.names).toEqual({ family: 'Doe; Jr', given: 'José', middle: '', prefix: 'Dr.', suffix: 'PhD' });
    expect(card!.fn).toBe('Dr. José Doe; Jr PhD');
    expect(card!.note).toBe('first\nsecond\\path,comma;semi');
  });

  it('unescapes uppercase \\N as a newline', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:n-2',
      'FN:N Escape',
      'NOTE:one\\Ntwo',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcf(vcf)[0]!.note).toBe('one\ntwo');
  });

  it('derives FN from N when FN is absent', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:n-1', 'N:Mustermann;Max', 'END:VCARD'].join('\r\n');
    expect(parseVcf(vcf)[0]!.fn).toBe('Max Mustermann');
  });

  it('always emits N (N:;;;; when names are absent) and FN', () => {
    const card: Vcard = { uid: 'bare-1', fn: '', emails: [], tels: [], addresses: [], raw: '' };
    const out = serializeVcard(card);
    expect(out).toContain('N:;;;;');
    expect(out).toContain('\r\nFN:\r\n');
  });
});

describe('vCard 3.0 input → 4.0 output', () => {
  it('bumps VERSION and refreshes REV to now', () => {
    setSystemTime(new Date('2026-10-09T12:00:00Z'));
    try {
      const out = serializeVcard(parseVcf(LEGACY_VCF)[0]!);
      expect(out).toContain('VERSION:4.0');
      expect(out).not.toContain('VERSION:3.0');
      expect(out).toContain('REV:20261009T120000Z');
      expect(parseVcf(out)[0]!.rev).toBe('20261009T120000Z');
    } finally {
      setSystemTime();
    }
  });
});

describe('folding', () => {
  it('folds a 200+ char NOTE at 75 octets without breaking multibyte characters', () => {
    const note = 'a'.repeat(150) + '日本語'.repeat(50) + 'z'.repeat(50);
    const card: Vcard = { uid: 'fold-1', fn: 'Fold Test', note, emails: [], tels: [], addresses: [], raw: '' };
    const out = serializeVcard(card);
    const physical = out.split('\r\n');
    expect(physical.length).toBeGreaterThan(2);
    for (const line of physical) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(physical.filter((line) => line.startsWith(' ')).length).toBeGreaterThan(0);
    expect(parseVcf(out)[0]!.note).toBe(note);
  });

  it('round-trips the folded Radicale PHOTO fixture within line limits', () => {
    const serialized = serializeVcard(parseVcf(PHOTO_VCF)[0]!);
    for (const line of serialized.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('group prefixes', () => {
  it('strips itemN. prefixes for TEL/EMAIL/ADR regardless of case', () => {
    const [card] = parseVcf(GROUP_VCF);
    expect(card!.tels).toEqual([
      { value: '+1-555-0100', types: ['cell'] },
      { value: '+1-555-0200', types: ['work'] },
    ]);
    expect(card!.emails).toEqual([{ value: 'home@example.com', types: ['home'] }]);
    expect(card!.addresses).toEqual([
      { value: ';;1 A St;Town;CA;90210;US', types: ['home'] },
    ]);
  });

  it('strips X-ABC- style group prefixes on EMAIL', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:grp-2',
      'FN:Apple Group',
      'X-ABC.EMAIL;TYPE=home:x@example.com',
      'END:VCARD',
    ].join('\r\n');
    expect(parseVcf(vcf)[0]!.emails).toEqual([{ value: 'x@example.com', types: ['home'] }]);
  });
});

describe('ORG components', () => {
  it('round-trips multi-component ORG byte-identically', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:org-1',
      'FN:Org Person',
      'ORG:Example Corp;Design',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVcf(vcf);
    expect(card!.org).toBe('Example Corp;Design');
    const out = serializeVcard(card!);
    expect(out.replace(/\r\n /g, '')).toContain('\r\nORG:Example Corp;Design\r\n');
  });
});

describe('BDAY', () => {
  it('parses and re-emits a full YYYY-MM-DD birthday', () => {
    const [card] = parseVcf(BDAY_VCF);
    expect(card!.bday).toBe('1980-04-06');
    const out = serializeVcard(card!);
    expect(out.replace(/\r\n /g, '')).toContain('\r\nBDAY:1980-04-06\r\n');
    expect(parseVcf(out)[0]!.bday).toBe('1980-04-06');
  });

  it('parses and re-emits a --MM-DD partial birthday verbatim', () => {
    const [card] = parseVcf(BDAY_PARTIAL_VCF);
    expect(card!.bday).toBe('--04-06');
    const out = serializeVcard(card!);
    expect(out.replace(/\r\n /g, '')).toContain('\r\nBDAY:--04-06\r\n');
    expect(parseVcf(out)[0]!.bday).toBe('--04-06');
  });

  it('tolerates TEXT escapes in BDAY values', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:bday-3',
      'FN:Text Bday',
      'BDAY:every 6\\, April',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVcf(vcf);
    expect(card!.bday).toBe('every 6, April');
    const out = serializeVcard(card!);
    expect(out.replace(/\r\n /g, '')).toContain('BDAY:every 6\\, April');
    expect(parseVcf(out)[0]!.bday).toBe('every 6, April');
  });

  it('absent BDAY stays undefined and emits no line', () => {
    const [card] = parseVcf(LEGACY_VCF);
    expect(card!.bday).toBeUndefined();
    expect(serializeVcard(card!)).not.toContain('BDAY:');
  });
});

describe('vCard 2.1 tolerance', () => {
  it('decodes QUOTED-PRINTABLE FN across = soft line breaks', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'UID:qp-1',
      'N;ENCODING=QUOTED-PRINTABLE:Test;M=C3=A1ria;;;',
      'FN;ENCODING=QUOTED-PRINTABLE:M=C3=A1r=',
      'ia Test',
      'TEL;TYPE=CELL:+1-555-0100',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVcf(vcf);
    expect(card!.fn).toBe('Mária Test');
    expect(card!.names).toEqual({ family: 'Test', given: 'Mária', middle: '', prefix: '', suffix: '' });
    expect(card!.tels).toEqual([{ value: '+1-555-0100', types: ['cell'] }]);
  });

  it('decodes QP escapes without a soft break too', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'UID:qp-2',
      'FN;ENCODING=QUOTED-PRINTABLE:CAF=C3=A9 Owner',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVcf(vcf);
    expect(card!.fn).toBe('CAFé Owner');
  });

  it('accumulates no-fold base64 PHOTO continuation lines', () => {
    const part1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const part2 = 'CAYAAAAfFcSJAAAADUlEQVR42mP8z8BQ';
    const part3 = 'DwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'UID:b64-1',
      'FN:Legacy Photo',
      `PHOTO;ENCODING=BASE64;TYPE=JPEG:${part1}`,
      part2,
      part3,
      '',
      'TEL;TYPE=CELL:+1-555-0100',
      'END:VCARD',
    ].join('\r\n');
    const [card] = parseVcf(vcf);
    expect(card!.photo).toBe(`data:image/jpeg;base64,${part1}${part2}${part3}`);
    // The blank line ends the payload; later properties parse normally.
    expect(card!.tels).toEqual([{ value: '+1-555-0100', types: ['cell'] }]);
  });
});

describe('input tolerances', () => {
  it('parses BOM-prefixed input', () => {
    const [card] = parseVcf('\uFEFF' + LEGACY_VCF);
    expect(card!.uid).toBe('legacy-1');
    expect(card!.fn).toBe('Legacy Contact');
  });

  it('parses CR-only and LF-only line endings', () => {
    expect(parseVcf(LEGACY_VCF.replace(/\r\n/g, '\r'))[0]!.fn).toBe('Legacy Contact');
    expect(parseVcf(LEGACY_VCF.replace(/\r\n/g, '\n'))[0]!.fn).toBe('Legacy Contact');
  });
});

describe('unknown properties', () => {
  it('stores non-handled lines in raw and re-emits them verbatim', () => {
    const [card] = parseVcf(RAW_VCF);
    expect(card!.raw).toBe('X-MOOD:happy\nURL:https://example.com/~u?a=1;b=2');
    const out = serializeVcard(card!);
    expect(out).toContain('X-MOOD:happy');
    expect(out).toContain('URL:https://example.com/~u?a=1;b=2');
    expect(out.indexOf('X-MOOD:happy')).toBeLessThan(out.indexOf('END:VCARD'));
  });
});

describe('vcard round-trip stability', () => {
  it('serialize(parse(x)) === serialize(parse(serialize(parse(x)))) for every fixture', () => {
    setSystemTime(new Date('2026-10-09T12:00:00Z')); // REV refreshes per write — freeze the clock
    try {
      for (const fixture of FIXTURES) expectRoundTripStable(fixture);
    } finally {
      setSystemTime();
    }
  });

  it('emits CRLF line endings and supports multiple cards per file', () => {
    setSystemTime(new Date('2026-10-09T12:00:00Z'));
    try {
      const combined = parseVcf(`${MULTI_VCF}\r\n\r\n${GROUP_VCF}`);
      expect(combined).toHaveLength(2);
      const serialized = serializeVcard(combined[0]!);
      expect(serialized.endsWith('\r\n')).toBe(true);
      expect(serialized.includes('\n\n')).toBe(false);
    } finally {
      setSystemTime();
    }
  });
});
