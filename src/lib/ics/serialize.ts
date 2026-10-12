// RFC 5545 serializer: VCALENDAR/VEVENT/VTODO with CRLF line endings, escaped
// text properties, folding of lines longer than 75 octets, DTSTAMP/PRODID
// defaults, SEQUENCE preservation, and UNTIL in Z form for timed rules.
// Unmodeled raw properties (STATUS, URL, TRANSP, CLASS, RDATE, foreign X-
// props) are merged back from the preserved component text, and stored
// VTIMEZONE blocks are re-emitted for referenced non-IANA TZIDs.

import type { IcsDate, IcsEvent, IcsTodo } from './types'
import { defaultUid, icsDateToDate, localDateStr, pad2 } from './types'
import { isValidTzid, utcToTzTime } from './tz'

interface SerializeOptions {
  method?: string
  prodId?: string
}

const CRLF = '\r\n'
const decoder = new TextDecoder()

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

function dateValueStr(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

function timeValueStr(wall: string): string {
  return wall.replace(/[-:]/g, '')
}

/** Property parameter prefix for a date/datetime property. */
function dateParams(d: IcsDate): string {
  if (d.date) return ';VALUE=DATE'
  if (d.tzid) return `;TZID=${d.tzid}`
  return ''
}

/** Property value for a date/datetime property (basic RFC 5545 form). */
function dateValue(d: IcsDate): string {
  if (d.date) return dateValueStr(d.date)
  if (d.tzid) return timeValueStr(utcToTzTime(d.utc, d.tzid))
  const wall = d.utc.slice(0, 19)
  if (d.floating) return timeValueStr(wall)
  return `${timeValueStr(wall)}Z`
}

/** Fold one logical line: first line ≤75 octets, continuations ' ' + ≤74. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const chunks: string[] = []
  let start = 0
  while (start < bytes.length) {
    const limit = start === 0 ? 75 : 74
    let end = Math.min(bytes.length, start + limit)
    // Never split inside a UTF-8 codepoint (continuation bytes are 10xxxxxx).
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push((start === 0 ? '' : ' ') + decoder.decode(bytes.slice(start, end)))
    start = end
  }
  return chunks.join(CRLF)
}

function nowStamp(): string {
  const d = new Date()
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/** RFC 5545: for timed rules UNTIL must be UTC — append Z when missing. */
function normalizeRrule(rrule: string, timed: boolean): string {
  if (!timed) return rrule
  return rrule.replace(/(UNTIL=)(\d{8}T\d{6})(?![0-9Z])/gi, '$1$2Z')
}

/**
 * EXDATE lines: values sharing a form are joined into one comma list.
 * Floating and UTC datetimes both have empty params, so the form class keeps
 * them apart. Shared by VEVENT and VTODO.
 */
function exdateLines(exdates: IcsDate[]): string[] {
  const groups: { key: string; params: string; values: string[] }[] = []
  for (const ex of exdates) {
    const key = `${dateParams(ex)}|${ex.date ? 'date' : ex.floating ? 'floating' : 'utc'}`
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, params: dateParams(ex), values: [] }
      groups.push(group)
    }
    group.values.push(dateValue(ex))
  }
  return groups.map((g) => `EXDATE${g.params}:${g.values.join(',')}`)
}

function recurrenceIdLines(id: string): string[] {
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return [`RECURRENCE-ID;VALUE=DATE:${dateValueStr(id)}`]
  if (id.endsWith('Z')) return [`RECURRENCE-ID:${timeValueStr(id.slice(0, 19))}Z`]
  return [`RECURRENCE-ID:${timeValueStr(id)}`]
}

/** Property names veventLines may emit — the raw-merge pass never re-emits these. */
const VEVENT_MODELED: Record<string, true> = {
  UID: true,
  SEQUENCE: true,
  'RECURRENCE-ID': true,
  DTSTAMP: true,
  SUMMARY: true,
  DTSTART: true,
  DTEND: true,
  RRULE: true,
  EXDATE: true,
  LOCATION: true,
  DESCRIPTION: true,
  ORGANIZER: true,
  ATTENDEE: true,
  CATEGORIES: true,
  'X-WYCAL-COLOR': true,
}

/** Property names vtodoLines may emit — the raw-merge pass never re-emits these. */
const VTODO_MODELED: Record<string, true> = {
  UID: true,
  SEQUENCE: true,
  DTSTAMP: true,
  SUMMARY: true,
  DESCRIPTION: true,
  DTSTART: true,
  DUE: true,
  RRULE: true,
  EXDATE: true,
  STATUS: true,
  'PERCENT-COMPLETE': true,
  PRIORITY: true,
  COMPLETED: true,
  CATEGORIES: true,
  'RELATED-TO': true,
  'X-WYCAL-COLOR': true,
}

/**
 * Unmodeled raw property lines (STATUS, TRANSP, CLASS, URL, RDATE, other
 * clients' X- props, …) re-emitted verbatim in original order, so an edit-PUT
 * does not silently drop them. Modeled names stay authoritative — whatever
 * veventLines/vtodoLines emit (or deliberately omit) wins over the raw text.
 * Sub-components (VALARM, …) are skipped wholesale: they are modeled.
 */
function rawMergeLines(raw: string | undefined, modeled: Record<string, true>): string[] {
  if (!raw) return []
  const out: string[] = []
  let depth = 0 // sub-component nesting (VALARM, …) below the component's own bounds
  let atOpener = true // the raw's first BEGIN: is the component's own opener
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line === '') continue
    if (/^BEGIN:/i.test(line)) {
      if (!atOpener) depth++
      atOpener = false
      continue
    }
    atOpener = false
    if (/^END:/i.test(line)) {
      if (depth > 0) depth--
      continue
    }
    if (depth > 0) continue
    const name = /^([^;:]+)/.exec(line)?.[1]?.trim().toUpperCase()
    if (!name || modeled[name] === true) continue
    out.push(line)
  }
  return out
}

/** VEVENT lines of one event (BEGIN/END included); `stamp` is the shared DTSTAMP. */
function veventLines(ev: IcsEvent, stamp: string): string[] {
  const lines: string[] = []
  lines.push('BEGIN:VEVENT')
  lines.push(`UID:${ev.uid || defaultUid()}`)
  if (ev.sequence !== undefined) lines.push(`SEQUENCE:${ev.sequence}`)
  if (ev.recurrenceId !== undefined) lines.push(...recurrenceIdLines(ev.recurrenceId))
  lines.push(`DTSTAMP:${stamp}`)
  lines.push(`SUMMARY:${escapeText(ev.summary)}`)

  const startDate = ev.allDay && !ev.start.date ? { ...ev.start, date: localDateStr(icsDateToDate(ev.start)) } : ev.start
  const endDate = ev.allDay && !ev.end.date ? { ...ev.end, date: localDateStr(icsDateToDate(ev.end)) } : ev.end
  lines.push(`DTSTART${dateParams(startDate)}:${dateValue(startDate)}`)
  lines.push(`DTEND${dateParams(endDate)}:${dateValue(endDate)}`)

  if (ev.rrule) lines.push(`RRULE:${normalizeRrule(ev.rrule, !ev.allDay)}`)

  lines.push(...exdateLines(ev.exdates))

  if (ev.location !== undefined) lines.push(`LOCATION:${escapeText(ev.location)}`)
  if (ev.description !== undefined) lines.push(`DESCRIPTION:${escapeText(ev.description)}`)
  if (ev.organizer !== undefined) lines.push(`ORGANIZER:${ev.organizer}`)
  for (const a of ev.attendees) lines.push(`ATTENDEE:${a}`)
  if (ev.categories.length > 0) lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(',')}`)
  if (ev.color !== undefined) lines.push(`X-WYCAL-COLOR:${ev.color}`)
  for (const alarm of ev.alarms) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:${alarm.trigger}`, 'END:VALARM')
  }
  lines.push(...rawMergeLines(ev.raw, VEVENT_MODELED))
  lines.push('END:VEVENT')
  return lines
}

/** SEQUENCE is not modeled on IcsTodo — read it back from the preserved raw component. */
function rawSequence(raw?: string): number | undefined {
  if (!raw) return undefined
  const m = /^SEQUENCE:\s*(\d+)\s*$/im.exec(raw)
  return m ? Number(m[1]) : undefined
}

/** VTODO lines of one todo (BEGIN/END included); `stamp` is the shared DTSTAMP. */
function vtodoLines(todo: IcsTodo, stamp: string): string[] {
  const lines: string[] = []
  lines.push('BEGIN:VTODO')
  lines.push(`UID:${todo.uid || defaultUid()}`)
  const seq = rawSequence(todo.raw)
  if (seq !== undefined) lines.push(`SEQUENCE:${seq}`)
  lines.push(`DTSTAMP:${stamp}`)
  lines.push(`SUMMARY:${escapeText(todo.summary)}`)
  if (todo.description !== undefined) lines.push(`DESCRIPTION:${escapeText(todo.description)}`)
  if (todo.dtstart) lines.push(`DTSTART${dateParams(todo.dtstart)}:${dateValue(todo.dtstart)}`)
  if (todo.due) lines.push(`DUE${dateParams(todo.due)}:${dateValue(todo.due)}`)
  if (todo.rrule) {
    // Timed unless the start/due is an all-day date — same UNTIL-Z rule as events.
    lines.push(`RRULE:${normalizeRrule(todo.rrule, !(todo.dtstart?.date ?? todo.due?.date))}`)
  }
  lines.push(...exdateLines(todo.exdates))
  lines.push(`STATUS:${todo.status}`)
  if (todo.percentComplete !== undefined) lines.push(`PERCENT-COMPLETE:${todo.percentComplete}`)
  if (todo.priority !== undefined) lines.push(`PRIORITY:${todo.priority}`)
  if (todo.completed) lines.push(`COMPLETED${dateParams(todo.completed)}:${dateValue(todo.completed)}`)
  if (todo.categories.length > 0) lines.push(`CATEGORIES:${todo.categories.map(escapeText).join(',')}`)
  if (todo.relatedTo !== undefined) lines.push(`RELATED-TO:${escapeText(todo.relatedTo)}`)
  if (todo.color !== undefined) lines.push(`X-WYCAL-COLOR:${todo.color}`)
  for (const alarm of todo.alarms) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:${alarm.trigger}`, 'END:VALARM')
  }
  lines.push(...rawMergeLines(todo.raw, VTODO_MODELED))
  lines.push('END:VTODO')
  return lines
}

/** TZIDs referenced by rendered component lines (`;TZID=` params). */
function referencedTzids(components: string[][]): Set<string> {
  const out = new Set<string>()
  for (const component of components) {
    for (const line of component) {
      const m = /(?:^|;)TZID=([^;:,\r\n]+)/i.exec(line)
      if (m) out.add(m[1])
    }
  }
  return out
}

/**
 * Stored VTIMEZONE blocks to re-emit: only for TZIDs still referenced by the
 * output and not resolvable as IANA zones — an IANA TZID needs no block, a
 * dangling custom TZID would degrade every date to wall-as-UTC. Deduped by
 * TZID, blocks spread into individual lines.
 */
function vtimezoneLines(blocks: string[], referenced: Set<string>): string[] {
  const out: string[] = []
  const emitted = new Set<string>()
  for (const block of blocks) {
    const tzid = /^TZID:(.+)$/im.exec(block)?.[1]?.trim()
    if (!tzid || emitted.has(tzid) || !referenced.has(tzid) || isValidTzid(tzid)) continue
    emitted.add(tzid)
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (line !== '') out.push(line)
    }
  }
  return out
}

/** One VCALENDAR wrapping the given components (a calendar object may hold several). */
function calendarDocument(componentLines: string[][], opts: SerializeOptions, vtimezones: string[] = []): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${opts.prodId ?? '-//wycal//EN'}`,
    'CALSCALE:GREGORIAN',
  ]
  if (opts.method) lines.push(`METHOD:${opts.method}`)
  lines.push(...vtimezoneLines(vtimezones, referencedTzids(componentLines)))
  for (const component of componentLines) lines.push(...component)
  lines.push('END:VCALENDAR')

  return `${lines.map(foldLine).join(CRLF)}${CRLF}`
}

/** One VCALENDAR wrapping every given VEVENT (a calendar object may hold several). */
export function serializeIcsEvents(events: IcsEvent[], opts: SerializeOptions = {}): string {
  const stamp = nowStamp()
  return calendarDocument(
    events.map((ev) => veventLines(ev, stamp)),
    opts,
    events.flatMap((ev) => ev.timezones ?? []),
  )
}

export function serializeIcsEvent(ev: IcsEvent, opts: SerializeOptions = {}): string {
  return serializeIcsEvents([ev], opts)
}

/** One VCALENDAR wrapping one VTODO (CONTRACTS.md §11). */
export function serializeIcsTodo(todo: IcsTodo, opts: SerializeOptions = {}): string {
  return calendarDocument([vtodoLines(todo, nowStamp())], opts, todo.timezones ?? [])
}

// Re-export for stores that build events for the wire (single import site
// together with the date helpers).
export { defaultUid, icsDateToDate, localMidnightIso, toIcsDateInput } from './types'
