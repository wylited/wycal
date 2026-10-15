// IANA timezone conversion via Intl.DateTimeFormat formatToParts (CONTRACTS §3).
// Wall times are 'YYYY-MM-DDTHH:MM:SS'. Unknown TZIDs warn (once) and are
// treated as floating/UTC so one bad server TZID can never break a sync.

import { pad2 } from './types'

const validTzidCache = new Map<string, boolean>()
const warnedTzids = new Set<string>()

export function isValidTzid(tzid: string): boolean {
  let known = validTzidCache.get(tzid)
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tzid }) // eslint-disable-line no-new
      known = true
    } catch {
      known = false
    }
    validTzidCache.set(tzid, known)
  }
  return known
}

function warnUnknownTzid(tzid: string, via: string): void {
  if (warnedTzids.has(tzid)) return
  warnedTzids.add(tzid)
  console.warn(`[wycal/tz] unknown TZID "${tzid}" (${via}); treating as floating/UTC`)
}

interface WallParts {
  y: number
  m: number
  d: number
  hh: number
  mm: number
  ss: number
}

function tzWallParts(date: Date, tzid: string): WallParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24, // guard locales yielding '24'
    mm: Number(parts.minute),
    ss: Number(parts.second),
  }
}

function utcFieldsOf(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  )
}

/**
 * Wall time in `tzid` → true UTC instant ('…Z' ISO).
 * Iterates the offset twice so times inside a DST transition converge.
 */
export function tzTimeToUtc(local: string, tzid: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m || !isValidTzid(tzid)) {
    warnUnknownTzid(m ? tzid : '(malformed time)', 'tzTimeToUtc')
    const fallback = m
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], Number(m[6] ?? 0)))
      : new Date(NaN)
    return isNaN(fallback.getTime()) ? new Date(0).toISOString() : fallback.toISOString()
  }
  const wallEpoch = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], Number(m[6] ?? 0))
  let instant = wallEpoch
  for (let i = 0; i < 2; i++) {
    const p = tzWallParts(new Date(instant), tzid)
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - instant
    instant = wallEpoch - offset
  }
  return new Date(instant).toISOString()
}

/** True UTC instant → wall time in `tzid`. */
export function utcToTzTime(utc: string, tzid: string): string {
  const d = new Date(utc)
  if (isNaN(d.getTime()) || !isValidTzid(tzid)) {
    warnUnknownTzid(isNaN(d.getTime()) ? '(malformed utc)' : tzid, 'utcToTzTime')
    return isNaN(d.getTime()) ? '1970-01-01T00:00:00' : utcFieldsOf(d)
  }
  const p = tzWallParts(d, tzid)
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`
}
