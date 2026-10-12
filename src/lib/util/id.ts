/**
 * Identifier generation (CONTRACTS §2 `lib/util/id.ts`).
 * UIDs look like `0f1e…@wycal` per the spec (`crypto.randomUUID` + `@wycal`).
 */

/** A bare RFC 4122 v4 UUID — used for account ids. */
export function randomUuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback for non-secure contexts where randomUUID is unavailable.
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  // Set RFC 4122 v4 bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** New VEVENT/VCARD UID: `crypto.randomUUID()@wycal` (spec-mandated shape). */
export function newUid(): string {
  return `${randomUuid()}@wycal`
}
