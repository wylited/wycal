// RFC 5545 parser: unfolds folded lines, handles property parameters
// (TZID / VALUE=DATE / comma lists), VALARM TRIGGERs, RECURRENCE-ID overrides
// as separate events, VTODO tasks, X-WYCAL-COLOR colors, VTIMEZONE blocks
// captured raw (and attached to components for non-IANA TZIDs so edit-PUTs
// can re-emit them). Tolerates unterminated components and impossible dates
// (epoch fallback), and drops a DTEND that precedes DTSTART.

import type { IcsDate, IcsEvent, IcsTodo } from './types'
import { localMidnightIso, recurrenceIdOf, shiftIcsDate } from './types'
import { tzTimeToUtc, isValidTzid } from './tz'

interface ParseResult {
  events: IcsEvent[]
  todos: IcsTodo[]
  timezones: Map<string, string>
}

interface Param {
  key: string
  values: string[]
}

interface ContentLine {
  name: string
  params: Param[]
  value: string
}

function unfold(text: string): string[] {
  const raw = text.split(/\r\n|\r|\n/)
  const out: string[] = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      out.push(line)
    }
  }
  return out
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const segs: string[] = []
  let cur = ''
  let inQuotes = false
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === sep && !inQuotes) {
      segs.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  segs.push(cur)
  return segs
}

function parseContentLine(line: string): ContentLine | null {
  let inQuotes = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const segs = splitOutsideQuotes(line.slice(0, colon), ';')
  const params: Param[] = []
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq < 0) continue
    const values = splitOutsideQuotes(seg.slice(eq + 1), ',').map((v) => v.replace(/^"|"$/g, ''))
    params.push({ key: seg.slice(0, eq).toUpperCase(), values })
  }
  return { name: segs[0].toUpperCase(), params, value: line.slice(colon + 1) }
}

function paramValue(line: ContentLine, key: string): string | undefined {
  return line.params.find((p) => p.key === key)?.values[0]
}

function unescapeText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1]
      if (next === 'n' || next === 'N' || next === ',' || next === ';' || next === '\\') {
        out += next === 'n' || next === 'N' ? '\n' : next
        i++
        continue
      }
    }
    out += ch
  }
  return out
}

/** Split an escaped TEXT value on unescaped top-level `sep` occurrences. */
function splitUnescaped(s: string, sep: string): string[] {
  const segs: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1]
      i++
    } else if (s[i] === sep) {
      segs.push(cur)
      cur = ''
    } else {
      cur += s[i]
    }
  }
  segs.push(cur)
  return segs
}

/** CATEGORIES comma list → text-unescaped values, empty segments dropped. */
function categoriesOf(value: string): string[] {
  return splitUnescaped(value, ',')
    .map(unescapeText)
    .filter((c) => c !== '')
}

/** X-WYCAL-COLOR carries exactly 6-digit hex (no alpha); anything else stays raw-only. */
function hexColorOf(value: string): string | undefined {
  const v = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined
}

/** Month/day sanity before any Date construction (reject impossible calendar dates). */
function validMonthDay(v: string): boolean {
  const month = Number(v.slice(4, 6))
  const day = Number(v.slice(6, 8))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** DTSTART/DTEND/EXDATE/RECURRENCE-ID value (+params) → IcsDate. */
function buildIcsDate(line: ContentLine): IcsDate {
  const v = line.value.trim()
  const epoch = { utc: new Date(0).toISOString() }
  const valueParam = (paramValue(line, 'VALUE') ?? '').toUpperCase()
  if (valueParam === 'DATE' || /^\d{8}$/.test(v)) {
    if (!/^\d{8}$/.test(v) || !validMonthDay(v)) return epoch
    const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
    return { utc: localMidnightIso(date), date }
  }
  // DATE-TIME accepts seconds- or minutes-precision times (20260303T090000 / T0900).
  const body = v.endsWith('Z') ? v.slice(0, -1) : v
  if (!/^\d{8}T\d{4}/.test(body) || !validMonthDay(v)) return epoch
  const time = body.slice(9)
  const wall = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6) || '00'}`
  const tzid = paramValue(line, 'TZID')
  if (tzid) return { utc: tzTimeToUtc(wall, tzid), tzid }
  const parsed = new Date(`${wall}Z`)
  const utc = isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
  if (v.endsWith('Z')) return { utc }
  return { utc, floating: true }
}

/** ISO-8601 duration (PnWnDTnHnMnS) → milliseconds; null when unparseable. */
function durationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!m) return null
  const secs =
    (Number(m[2] ?? 0) * 604800 +
      Number(m[3] ?? 0) * 86400 +
      Number(m[4] ?? 0) * 3600 +
      Number(m[5] ?? 0) * 60 +
      Number(m[6] ?? 0)) *
    1000
  return m[1] === '-' ? -secs : secs
}

interface EventDraft {
  ev: IcsEvent
  startIdx: number
  durMs: number | null
  sawEnd: boolean
}

function newDraft(): EventDraft {
  return {
    ev: {
      uid: '',
      summary: '',
      start: { utc: new Date(0).toISOString() },
      end: { utc: new Date(0).toISOString() },
      allDay: false,
      exdates: [],
      attendees: [],
      categories: [],
      alarms: [],
    },
    startIdx: 0,
    durMs: null,
    sawEnd: false,
  }
}

/** Fresh VTODO draft; startIdx is taken from the component's stack frame. */
function newTodo(): IcsTodo {
  return {
    uid: '',
    summary: '',
    status: 'NEEDS-ACTION',
    categories: [],
    exdates: [],
    alarms: [],
  }
}

function finalizeDraft(draft: EventDraft, lines: string[], endIdx: number): IcsEvent {
  const ev = draft.ev
  if (!draft.sawEnd) {
    ev.end =
      draft.durMs !== null
        ? shiftIcsDate(ev.start, draft.durMs)
        : { utc: ev.start.utc, tzid: ev.start.tzid, floating: ev.start.floating, date: ev.start.date }
  } else if (Date.parse(ev.end.utc) < Date.parse(ev.start.utc)) {
    // Nonsensical negative duration (broken producer): keep DTSTART, drop DTEND
    // — treat as zero-duration at DTSTART instead of corrupting renders.
    console.warn(`[wycal/ics] DTEND before DTSTART on ${ev.uid || '(no uid)'}; dropping DTEND`)
    ev.end = { utc: ev.start.utc, tzid: ev.start.tzid, floating: ev.start.floating, date: ev.start.date }
  }
  ev.allDay = ev.start.date !== undefined
  ev.raw = lines.slice(draft.startIdx, endIdx + 1).join('\r\n')
  if (ev.recurrenceId !== undefined) ev.provenance = 'override'
  return ev
}

export function parseIcs(text: string): ParseResult {
  const lines = unfold(text)
  const events: IcsEvent[] = []
  const todos: IcsTodo[] = []
  const timezones = new Map<string, string>()
  // Stack of open components; VEVENT/VTODO frames carry the draft under construction.
  const stack: { type: string; startIdx: number; draft?: EventDraft; todo?: IcsTodo; tzid?: string }[] = []

  /** Emit one closed component; `endIdx` is the last line belonging to it. */
  const closeFrame = (frame: (typeof stack)[number], endIdx: number): void => {
    if (frame.type === 'VEVENT' && frame.draft) events.push(finalizeDraft(frame.draft, lines, endIdx))
    if (frame.type === 'VTODO' && frame.todo) {
      frame.todo.raw = lines.slice(frame.startIdx, endIdx + 1).join('\r\n')
      todos.push(frame.todo)
    }
    if (frame.type === 'VTIMEZONE' && frame.tzid) {
      timezones.set(frame.tzid, lines.slice(frame.startIdx, endIdx + 1).join('\r\n'))
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const begin = /^BEGIN:(.+)$/i.exec(line)
    if (begin) {
      const type = begin[1].trim().toUpperCase()
      const frame: (typeof stack)[number] = { type, startIdx: i }
      if (type === 'VEVENT') {
        frame.draft = newDraft()
        frame.draft.startIdx = i
      }
      if (type === 'VTODO') frame.todo = newTodo()
      stack.push(frame)
      continue
    }
    const end = /^END:(.+)$/i.exec(line)
    if (end) {
      const type = end[1].trim().toUpperCase()
      // Pop until the matching frame (tolerate malformed nesting). Frames
      // spliced above it were never closed — emit them too instead of
      // dropping (e.g. a missing END:VEVENT before END:VCALENDAR).
      let idx = stack.length - 1
      while (idx > 0 && stack[idx].type !== type) idx--
      if (stack[idx]?.type !== type) continue
      const popped = stack.splice(idx)
      for (let f = popped.length - 1; f >= 0; f--) closeFrame(popped[f], i)
      continue
    }

    const parsed = parseContentLine(line)
    if (!parsed) continue
    const top = stack[stack.length - 1]
    if (!top) continue

    if (top.type === 'VTIMEZONE') {
      if (parsed.name === 'TZID' && !top.tzid) top.tzid = parsed.value.trim()
      continue
    }
    if (top.type === 'VALARM') {
      if (parsed.name === 'TRIGGER') {
        for (let f = stack.length - 2; f >= 0; f--) {
          const frame = stack[f]
          if (frame.draft) {
            frame.draft.ev.alarms.push({ trigger: parsed.value.trim() })
            break
          }
          if (frame.todo) {
            frame.todo.alarms.push({ trigger: parsed.value.trim() })
            break
          }
        }
      }
      continue
    }
    if (top.type === 'VTODO') {
      const todo = top.todo
      if (!todo) continue
      switch (parsed.name) {
        case 'UID':
          todo.uid = parsed.value.trim()
          break
        case 'SUMMARY':
          todo.summary = unescapeText(parsed.value)
          break
        case 'DESCRIPTION':
          todo.description = unescapeText(parsed.value)
          break
        case 'DTSTART':
          todo.dtstart = buildIcsDate(parsed)
          break
        case 'DUE':
          todo.due = buildIcsDate(parsed)
          break
        case 'STATUS': {
          const s = parsed.value.trim().toUpperCase()
          if (s === 'NEEDS-ACTION' || s === 'IN-PROCESS' || s === 'COMPLETED' || s === 'CANCELLED') {
            todo.status = s
          }
          break
        }
        case 'COMPLETED':
          todo.completed = buildIcsDate(parsed)
          break
        case 'PERCENT-COMPLETE': {
          const n = Number(parsed.value.trim())
          if (Number.isInteger(n) && n >= 0 && n <= 100) todo.percentComplete = n
          break
        }
        case 'PRIORITY': {
          const n = Number(parsed.value.trim())
          if (Number.isInteger(n) && n >= 1 && n <= 9) todo.priority = n as IcsTodo['priority']
          break
        }
        case 'CATEGORIES':
          for (const c of categoriesOf(parsed.value)) todo.categories.push(c)
          break
        case 'RELATED-TO':
          todo.relatedTo = unescapeText(parsed.value.trim())
          break
        case 'RRULE':
          todo.rrule = parsed.value.trim()
          break
        case 'EXDATE':
          for (const v of parsed.value.split(',')) {
            if (v.trim().length === 0) continue
            todo.exdates.push(buildIcsDate({ ...parsed, value: v }))
          }
          break
        case 'X-WYCAL-COLOR': {
          const hex = hexColorOf(parsed.value)
          if (hex !== undefined) todo.color = hex
          break
        }
        default:
          break // X- props and unknowns survive in todo.raw
      }
      continue
    }
    const draft = top.draft
    if (top.type !== 'VEVENT' || !draft) continue
    const ev = draft.ev
    switch (parsed.name) {
      case 'UID':
        ev.uid = parsed.value.trim()
        break
      case 'SUMMARY':
        ev.summary = unescapeText(parsed.value)
        break
      case 'LOCATION':
        ev.location = unescapeText(parsed.value)
        break
      case 'DESCRIPTION':
        ev.description = unescapeText(parsed.value)
        break
      case 'CATEGORIES':
        for (const c of categoriesOf(parsed.value)) ev.categories.push(c)
        break
      case 'X-WYCAL-COLOR': {
        const hex = hexColorOf(parsed.value)
        if (hex !== undefined) ev.color = hex
        break
      }
      case 'SEQUENCE': {
        const n = Number(parsed.value.trim())
        if (Number.isFinite(n)) ev.sequence = n
        break
      }
      case 'ORGANIZER':
        ev.organizer = parsed.value.trim()
        break
      case 'ATTENDEE':
        ev.attendees.push(parsed.value.trim())
        break
      case 'RRULE':
        ev.rrule = parsed.value.trim()
        break
      case 'DTSTART':
        ev.start = buildIcsDate(parsed)
        break
      case 'DTEND':
        ev.end = buildIcsDate(parsed)
        draft.sawEnd = true
        break
      case 'DURATION':
        draft.durMs = durationMs(parsed.value)
        break
      case 'EXDATE':
        for (const v of parsed.value.split(',')) {
          if (v.trim().length === 0) continue
          ev.exdates.push(buildIcsDate({ ...parsed, value: v }))
        }
        break
      case 'RECURRENCE-ID':
        ev.recurrenceId = recurrenceIdOf(buildIcsDate(parsed))
        break
      default:
        break // X- props and unknowns survive in ev.raw
    }
  }
  // EOF with still-open components (missing END:): finalize the drafted
  // components instead of dropping them — mirrors the vcard parser's
  // tolerance for a missing END:VCARD.
  const open = stack.splice(0)
  for (let f = open.length - 1; f >= 0; f--) closeFrame(open[f], lines.length - 1)

  // Carry raw VTIMEZONE blocks for referenced non-IANA TZIDs so edit-PUTs can
  // re-emit them (serialize appends the block when the TZID is not resolvable
  // through Intl — a dangling TZID would degrade times to wall-as-UTC).
  for (const ev of events) {
    const blocks = vtimezoneBlocksFor(timezones, [ev.start, ev.end, ...ev.exdates])
    if (blocks.length > 0) ev.timezones = blocks
  }
  for (const todo of todos) {
    const blocks = vtimezoneBlocksFor(timezones, [todo.dtstart, todo.due, todo.completed, ...todo.exdates])
    if (blocks.length > 0) todo.timezones = blocks
  }
  return { events, todos, timezones }
}

/** Raw blocks of `timezones` for the dates' non-IANA TZIDs, deduped in first-seen order. */
function vtimezoneBlocksFor(timezones: Map<string, string>, dates: (IcsDate | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const d of dates) {
    if (!d?.tzid || seen.has(d.tzid)) continue
    seen.add(d.tzid)
    if (isValidTzid(d.tzid)) continue // IANA zones resolve via Intl; no block needed
    const block = timezones.get(d.tzid)
    if (block !== undefined) out.push(block)
  }
  return out
}
