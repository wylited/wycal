/** Color helpers for calendar/event coloring (design.md §1 event palette). */
import { collectionColor, collections } from '../../stores/calendars'
import { getCalDefaults } from '../../stores/caldefaults'

/**
 * Auto-assign event palette, in design.md order (Ayu syntax colors).
 * Used round-robin by `collectionColor` when a collection has no
 * ICAL:calendar-color set.
 */
export const EVENT_COLORS: readonly string[] = [
  '#55b4d4', // blue
  '#86b300', // green
  '#f07178', // red
  '#a37acc', // purple
  '#cca700', // yellow
  '#4cc2b4', // cyan
  '#fa8d3e', // orange
  '#d597c0', // pink
]

interface PaletteSwatch {
  /** Stable id (design.md §9.3). */
  name: string
  hex: string
}

/**
 * Curated 24-color palette (design.md §9.3, law for pickers): both-theme-safe
 * mid lightness, pairs with soft tints at 16% alpha. Used by calendar color
 * pickers, event color overrides and contact avatars (hash → index).
 */
export const PALETTE: readonly PaletteSwatch[] = [
  { name: 'red', hex: '#e05661' },
  { name: 'coral', hex: '#f07178' },
  { name: 'salmon', hex: '#f28779' },
  { name: 'orange', hex: '#fa8d3e' },
  { name: 'amber', hex: '#e6b67d' },
  { name: 'sand', hex: '#cca700' },
  { name: 'olive', hex: '#98971a' },
  { name: 'lime', hex: '#86b300' },
  { name: 'grass', hex: '#7fb454' },
  { name: 'mint', hex: '#4cc2b4' },
  { name: 'teal', hex: '#95e6cb' },
  { name: 'sky', hex: '#55b4d4' },
  { name: 'azure', hex: '#39bae6' },
  { name: 'cobalt', hex: '#5b8fdf' },
  { name: 'periwinkle', hex: '#6c9ef8' },
  { name: 'iris', hex: '#a37acc' },
  { name: 'lilac', hex: '#b888e2' },
  { name: 'violet', hex: '#d2a6ff' },
  { name: 'orchid', hex: '#d597c0' },
  { name: 'rose', hex: '#e0879e' },
  { name: 'slate', hex: '#8a9199' },
  { name: 'graphite', hex: '#6c7380' },
  { name: 'moss', hex: '#7a9e7e' },
  { name: 'pine', hex: '#3f8f6f' },
]

/**
 * Resolved display color for an event or todo record (CONTRACTS §14):
 * record's own `X-WYCAL-COLOR` → per-calendar default event color → the
 * owning collection's color. `undefined` when the collection is unknown and
 * nothing earlier in the chain matches.
 */
export function eventColorFor(record: { color?: string; calendarUrl: string }): string | undefined {
  if (record.color && record.color.trim().length > 0) return record.color.trim()
  const defaults = getCalDefaults(record.calendarUrl)
  if (defaults.eventColor && defaults.eventColor.trim().length > 0) return defaults.eventColor.trim()
  const cal = collections.value.find((c) => c.url === record.calendarUrl)
  return cal ? collectionColor(cal) : undefined
}

/**
 * Convert `#rgb` / `#rrggbb` to a CSS `rgba(...)` string with the given alpha
 * (0–1). Used for the `-soft` pill fills from design.md (hex + `26` alpha).
 * Returns a best-effort value for unparseable input (the hex itself).
 */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.trim().replace(/^#/, '')
  let r = 0
  let g = 0
  let b = 0
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16)
    g = parseInt(h[1] + h[1], 16)
    b = parseInt(h[2] + h[2], 16)
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16)
    g = parseInt(h.slice(2, 4), 16)
    b = parseInt(h.slice(4, 6), 16)
  } else {
    return hex
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
