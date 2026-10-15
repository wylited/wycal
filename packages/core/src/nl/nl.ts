/**
 * Unified natural-language interpretation for the command palette (wave 14).
 * Wraps the tasks/quickAdd token pass — which already parses dates, times,
 * durations, priority and tags, and now reports each consumed token's span
 * (ParsedChip) — and adds the KashCal quick-add grammar pieces it lacks,
 * ported as the same PATTERN (recognize → consume → remainder is the title),
 * not the Kotlin code:
 *
 * - recurrence  'every day' · 'every 2 weeks' · 'every other week' ·
 *               'every monday' · 'every mon and weds' · 'weekdays' ·
 *               'daily'/'weekly'/'fortnightly'/'monthly'/'yearly' · plural
 *               weekdays ('gym mondays') → an RRULE fragment
 *               (FREQ=…;INTERVAL=…;BYDAY=…); with a BYDAY rule and no
 *               explicitly typed date, the start rolls forward to the first
 *               matching weekday (today counts) so the preview start equals
 *               the series' first saved occurrence
 * - all-day     'all day' / 'all-day' anywhere → allDay (words blanked out
 *               of the title; the date itself still comes from the base pass)
 * - due         a standalone 'due' directly before a date token ('report due
 *               friday') joins the date's chip and leaves the title — times
 *               and durations after 'due' don't count
 * - location    'at <place>' / '@<place>' — tried only where a TIME does not
 *               fit ('at 3pm' is a time, never a place; kashcal's TimeRule
 *               ordering — day parts like 'at dawn' count as times too),
 *               scanning from the LAST 'at' backwards so a later time pair
 *               can't steal the location
 * - contacts    a leading 'contact <name>', or an email / phone token (with
 *               an optional leading verb — 'call john john@x.com') → a
 *               contact candidate {fn, email?, tel?}; a trailing standalone
 *               tel-shaped token wins so the fn stays clean
 *
 * Overlay rules run on a length-preserving blanked copy of the input, so the
 * base pass's chip offsets stay valid against the ORIGINAL line — the
 * palette highlights every consumed fragment in place. Pure module: no
 * store imports.
 */
import { parseQuickAddLine } from './quickAdd'
import type { ParsedChip } from './quickAdd'

/** Human hint for a parsed due (todo preview lines) — re-exported so the
 *  facade's single `nl` slot carries the whole palette NL surface. */
export { describeDue } from './quickAdd'

/** What an interpreted line creates. */
export type InterpKind = 'event' | 'todo' | 'contact'

/** Base-pass chip kinds plus the overlay rules' own kinds. */
export type ChipKind = ParsedChip['kind'] | 'recurrence' | 'location' | 'contact-name' | 'contact-info'

/** One consumed fragment, positioned in the original input. */
export interface Chip {
  start: number
  end: number
  text: string
  kind: ChipKind
}

/** A contact candidate extracted from the line. */
export interface ContactCandidate {
  fn: string
  email?: string
  tel?: string
}

export interface Interpretation {
  kind: InterpKind
  /** Everything the rules did NOT consume (the create-action's subject). */
  title: string
  /** Event start when the line parsed a wall time; undefined otherwise. */
  when?: Date
  /** The parsed date (event start date or todo due); undefined when none. */
  due?: Date
  /** True when nothing timed was parsed or an explicit 'all day' /
   *  'all-day' was consumed. */
  allDay: boolean
  durationMin?: number
  /** RRULE fragment, e.g. 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'. */
  rrule?: string
  location?: string
  /** PRIORITY 1–9 — the grammar emits #A/#B/#C as 1/5/9; palette fields
   *  mode may forward any 1–9. */
  priority?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  tags: string[]
  contact?: ContactCandidate
  confidence: 'high' | 'medium' | 'low'
  /** Every consumed fragment, sorted by position in the original input. */
  chips: Chip[]
  /** The untouched input line (the create prefill). */
  raw: string
}

// ---------------------------------------------------------------------------
// Word walker (offset-preserving scans)
// ---------------------------------------------------------------------------

interface Word {
  text: string
  start: number
  end: number
}

function words(s: string): Word[] {
  const out: Word[] = []
  const re = /\S+/g
  for (let h = re.exec(s); h !== null; h = re.exec(s)) {
    out.push({ text: h[0], start: h.index, end: h.index + h[0].length })
  }
  return out
}

/** Blank [start, end) with spaces, preserving length (chip offsets survive). */
function blank(s: string, start: number, end: number): string {
  return s.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + s.slice(end)
}

// ---------------------------------------------------------------------------
// Recurrence (kashcal RecurrenceRule pattern: run BEFORE any single-date rule)
// ---------------------------------------------------------------------------

/** JS getDay() per weekday spelling (full names, 3-letter, 'weds'/'tues'). */
const WEEKDAY_NO: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}

interface RecHit {
  rrule: string
  start: number
  end: number
}

/** Trailing punctuation a word may carry when glued to a list separator. */
function bareWord(w: Word | undefined): string {
  return w === undefined ? '' : w.text.toLowerCase().replace(/[.,;]$/, '')
}

/**
 * 'every …' / 'each …': [other] [N] (unit | weekday-list). Returns undefined
 * when no unit or weekday follows — 'every good boy' stays title text.
 */
function everyPattern(ws: Word[], i: number): RecHit | undefined {
  let cursor = i + 1
  let interval: number | undefined
  if (bareWord(ws[cursor]) === 'other') {
    interval = 2
    cursor += 1
  }
  if (interval === undefined) {
    const t = bareWord(ws[cursor])
    const n = /^\d{1,2}$/.test(t) ? Number(t) : NUMBER_WORDS[t]
    if (n !== undefined && n >= 1 && n <= 99) {
      interval = n
      cursor += 1
    }
  }
  const unit = bareWord(ws[cursor])
  if (unit === '') return undefined
  let rrule: string | undefined
  let last = cursor
  if (/^days?$/.test(unit)) rrule = 'FREQ=DAILY'
  else if (/^weeks?$/.test(unit)) rrule = 'FREQ=WEEKLY'
  else if (/^months?$/.test(unit)) rrule = 'FREQ=MONTHLY'
  else if (/^years?$/.test(unit)) rrule = 'FREQ=YEARLY'
  else if (/^weekdays?$/.test(unit)) rrule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  else {
    // Weekday list: 'every mon', 'every monday and weds', 'every mon, wed, fri'.
    const days: number[] = []
    for (;;) {
      const no = WEEKDAY_NO[bareWord(ws[cursor])]
      if (no === undefined) break
      if (!days.includes(no)) days.push(no)
      last = cursor
      cursor += 1
      if (bareWord(ws[cursor]) !== 'and') break
      cursor += 1
    }
    if (days.length === 0) return undefined
    rrule = `FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(',')}`
  }
  if (interval !== undefined && interval > 1) rrule += `;INTERVAL=${interval}`
  return { rrule, start: ws[i].start, end: ws[last].end }
}

function scanRecurrence(input: string): RecHit | undefined {
  const ws = words(input)
  for (let i = 0; i < ws.length; i++) {
    const t = ws[i].text.toLowerCase()
    if ((t === 'every' || t === 'each')) {
      const hit = everyPattern(ws, i)
      if (hit !== undefined) return hit
    }
  }
  // Bare adverbs and plural weekdays ('gym mondays') — first hit wins.
  for (const w of ws) {
    const t = w.text.toLowerCase()
    if (t === 'daily') return { rrule: 'FREQ=DAILY', start: w.start, end: w.end }
    if (t === 'weekly') return { rrule: 'FREQ=WEEKLY', start: w.start, end: w.end }
    if (t === 'fortnightly' || t === 'biweekly') return { rrule: 'FREQ=WEEKLY;INTERVAL=2', start: w.start, end: w.end }
    if (t === 'monthly') return { rrule: 'FREQ=MONTHLY', start: w.start, end: w.end }
    if (t === 'yearly' || t === 'annually') return { rrule: 'FREQ=YEARLY', start: w.start, end: w.end }
    if (t === 'weekdays') return { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start: w.start, end: w.end }
    if (t === 'weekends') return { rrule: 'FREQ=WEEKLY;BYDAY=SA,SU', start: w.start, end: w.end }
    const singular = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s$/.test(t)
      ? t.slice(0, -1)
      : undefined
    if (singular !== undefined && WEEKDAY_NO[singular] !== undefined) {
      return { rrule: `FREQ=WEEKLY;BYDAY=${BYDAY[WEEKDAY_NO[singular]]}`, start: w.start, end: w.end }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Location (kashcal LocationRule pattern: time shapes win first, LAST 'at')
// ---------------------------------------------------------------------------

const MONTH_SPELLINGS: Record<string, true> = {
  jan: true, feb: true, mar: true, apr: true, may: true, jun: true, jul: true,
  aug: true, sep: true, sept: true, oct: true, nov: true, dec: true,
  january: true, february: true, march: true, april: true, june: true,
  july: true, august: true, september: true, october: true, november: true,
  december: true,
}

/** Words that end a place name (the next rule's territory starts there). */
const PLACE_STOP: Record<string, true> = {
  at: true, on: true, in: true, for: true, from: true, with: true, and: true,
  next: true, today: true, tod: true, tomorrow: true, tom: true, tmr: true,
  tonight: true, yesterday: true, due: true,
}

/** Day-part words: 'at <x>' with one of these is a (potential) time pair,
 *  never a place — 'attack at dawn' keeps 'at dawn' in the title. */
const TIME_OF_DAY: Record<string, true> = {
  dawn: true, dusk: true, noon: true, midnight: true, night: true,
  morning: true, afternoon: true, evening: true, tonight: true,
}

/** A follower that makes 'at X' a time pair, not a place (kashcal ordering). */
function timeShaped(word: Word | undefined): boolean {
  if (word === undefined) return true
  const t = word.text.toLowerCase()
  return /^\d/.test(t) || TIME_OF_DAY[t] === true
}

function scanLocation(input: string): { location: string; start: number; end: number } | undefined {
  const ws = words(input)
  for (let i = ws.length - 1; i >= 0; i--) {
    const t = ws[i].text.toLowerCase()
    const atForm = t === 'at'
    const atSignForm = ws[i].text.startsWith('@') && ws[i].text.length > 1
    if (!atForm && !atSignForm) continue
    let cursor = i + 1
    // 'at 3pm' / a bare trailing 'at' → try an earlier 'at'. An '@place'
    // token carries its own place (no follower needed — '@office' at the end
    // of the line still lands), but its content is still time-checked:
    // '@3pm'/'@dawn' are handles, not places.
    if (atForm && timeShaped(ws[cursor])) continue
    if (atSignForm && timeShaped({ text: ws[i].text.slice(1), start: ws[i].start, end: ws[i].end })) continue
    const placeWords: string[] = []
    if (atSignForm) placeWords.push(ws[i].text.slice(1).replace(/[.,;:!]$/, ''))
    let last = atSignForm ? i : -1
    for (;;) {
      const w = ws[cursor]
      if (w === undefined) break
      const bare = w.text.replace(/[.,;:!]$/, '')
      const lower = bare.toLowerCase()
      if (!/^[A-Za-z&'’.-]+$/.test(bare)) break // digits → time/date territory
      if (PLACE_STOP[lower] === true || WEEKDAY_NO[lower] !== undefined || MONTH_SPELLINGS[lower] === true) break
      placeWords.push(bare)
      last = cursor
      cursor += 1
    }
    if (placeWords.length === 0 || placeWords.every((p) => p === '')) continue
    return { location: placeWords.join(' '), start: ws[i].start, end: ws[last].end }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// All-day ('all day' / 'all-day' anywhere → allDay; words blanked)
// ---------------------------------------------------------------------------

/**
 * 'all day' (two words) or 'all-day'/'allday' (one hyphenated token). The
 * words carry no date themselves — the base pass keeps parsing the line's
 * date; blanking here just keeps them out of the title and flags allDay.
 */
function scanAllDay(input: string): { start: number; end: number } | undefined {
  const ws = words(input)
  for (let i = 0; i < ws.length; i++) {
    const t = ws[i].text.toLowerCase()
    if (/^all-?days?$/.test(t)) return { start: ws[i].start, end: ws[i].end }
    if (t === 'all') {
      const next = bareWord(ws[i + 1])
      if (next === 'day' || next === 'days') return { start: ws[i].start, end: ws[i + 1].end }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 'due' keyword ('report due friday' → 'due' leaves the title once a date
// token directly follows it; the date itself still comes from the base pass)
// ---------------------------------------------------------------------------

/**
 * Does the word at ws[i] head a base-pass date token? Relative words,
 * (next) weekdays, month names, '10/24', '31st'/'3rd', '24 oct' (digit plus
 * month word) and 'in 3 days' ('in' plus digit) all count. Times and
 * durations ('due 5pm', 'due 30m') are NOT date heads — 'due' stays in the
 * title there.
 */
function dateHeaded(ws: Word[], i: number): boolean {
  const t = bareWord(ws[i])
  if (t === '') return false
  if (/^(?:today|tod|tomorrow|tom|tmr|yesterday|next)$/.test(t)) return true
  if (WEEKDAY_NO[t] !== undefined || MONTH_SPELLINGS[t] === true) return true
  if (/^\d/.test(t)) {
    if (/^\d{1,2}\/\d{1,2}$/.test(t) || /^\d{1,2}(?:st|nd|rd|th)$/.test(t)) return true
    return /^\d{1,2}$/.test(t) && MONTH_SPELLINGS[bareWord(ws[i + 1])] === true
  }
  if (t === 'in') return /^\d/.test(bareWord(ws[i + 1]))
  return false
}

/** A standalone 'due' directly before a date token: consumed as a date chip
 *  so 'todo: Report due Friday' titles as 'Report' with Friday as the due. */
function scanDueKeyword(input: string): { start: number; end: number } | undefined {
  const ws = words(input)
  for (let i = 0; i < ws.length; i++) {
    if (bareWord(ws[i]) === 'due' && dateHeaded(ws, i + 1)) return { start: ws[i].start, end: ws[i].end }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Contacts ('contact …' lead, or an email/phone token)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/

/** Digit-run candidate for a phone number; validated by telOk. */
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/

/** A trailing STANDALONE tel token: 7+ chars of digits/parens/dashes with an
 *  optional leading '+' and no letters. Still telOk-checked, so a date-shaped
 *  trailing run ('2026-10-14') is never taken as a phone. */
const TEL_TOKEN_RE = /^\+?[\d().-]{7,}$/

const CONTACT_LEAD_RE = /^\s*(?:add\s+)?contact(?:\s+for)?[:\s]+/i

/** Leading words dropped from the candidate name ('call john' → 'john'). */
const CONTACT_VERBS: Record<string, true> = {
  call: true, email: true, mail: true, text: true, phone: true, ring: true,
  reach: true, contact: true, add: true, new: true,
}

/**
 * Phone sanity: 7–15 digits, and NOT a date-shaped run ('2026-10-14',
 * '14.10.2026' — the year-bearing forms are dates, never phone numbers). The
 * D.M.Y shape needs BOTH separators, so '555-0100' (whose '-0100' tail
 * superficially reads as '-0100') stays a phone.
 */
function telOk(s: string): boolean {
  const digits = (s.match(/\d/g) ?? []).length
  if (digits < 7 || digits > 15) return false
  return !/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/.test(s) && !/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(s)
}

function detectContact(
  input: string,
): { candidate: ContactCandidate; chips: Chip[]; confidence: 'high' | 'medium' } | undefined {
  const lead = CONTACT_LEAD_RE.exec(input)
  let padded = input
  if (lead !== null) padded = ' '.repeat(lead[0].length) + input.slice(lead[0].length)

  // Email first; the phone scan then runs over the email-blanked copy so one
  // regex can't bite into the other's span. Match indexes stay valid against
  // the original line (blanking preserves length).
  const email = EMAIL_RE.exec(padded)
  if (email !== null) padded = blank(padded, email.index, email.index + email[0].length)
  // Tel: a trailing standalone token wins ('maya@x.com 555-0100') — it must
  // be whitespace-separated from the name, so digit-bearing words beside it
  // ('Room 12 555-0100') stay in the name and the fn comes back clean. The
  // blanket scan stays as the fallback for a phone sitting mid-line.
  const tail = (() => {
    const ws = words(padded)
    return ws.length > 0 ? ws[ws.length - 1] : undefined
  })()
  let tel: string | undefined
  let telIndex = -1
  if (tail !== undefined && TEL_TOKEN_RE.test(tail.text) && telOk(tail.text)) {
    tel = tail.text
    telIndex = tail.start
  }
  if (tel === undefined) {
    const telMatch = PHONE_RE.exec(padded)
    if (telMatch !== null && telOk(telMatch[0])) {
      tel = telMatch[0]
      telIndex = telMatch.index
    }
  }
  if (tel !== undefined) padded = blank(padded, telIndex, telIndex + tel.length)

  const leadMatched = lead !== null
  if (!leadMatched && email === null && tel === undefined) return undefined

  // Name = leftover words minus leading verbs ('call', 'contact', …).
  const rest = words(padded)
  let first = 0
  while (first < rest.length && CONTACT_VERBS[rest[first].text.toLowerCase()] === true) first += 1
  const nameWords = rest.slice(first)
  const fn = nameWords.map((w) => w.text).join(' ').trim()
  // A bare phone with no name at all isn't confidently a contact.
  if (!leadMatched && email === null && fn === '') return undefined

  const chips: Chip[] = []
  if (nameWords.length > 0) {
    chips.push({
      start: nameWords[0].start,
      end: nameWords[nameWords.length - 1].end,
      text: fn,
      kind: 'contact-name',
    })
  }
  if (email !== null) {
    chips.push({ start: email.index, end: email.index + email[0].length, text: email[0], kind: 'contact-info' })
  }
  if (tel !== undefined) {
    chips.push({ start: telIndex, end: telIndex + tel.length, text: tel, kind: 'contact-info' })
  }
  return {
    candidate: {
      fn: fn !== '' ? fn : email !== null ? email[0].split('@')[0] : 'New contact',
      email: email?.[0],
      tel,
    },
    chips,
    confidence: leadMatched || (email !== null && fn !== '') ? 'high' : 'medium',
  }
}

// ---------------------------------------------------------------------------
// interpret — the palette's one entry point
// ---------------------------------------------------------------------------

/**
 * Parse one palette line: contact detection first (it owns the line), then
 * the recurrence + all-day + location overlays on a length-preserving copy,
 * then the shared quickAdd token pass for dates/times/durations/priority/
 * tags. The returned chips (overlay + base, sorted by position) drive the
 * live chip-highlighted create preview.
 */
export function interpret(input: string): Interpretation {
  const contact = detectContact(input)
  if (contact !== undefined) {
    return {
      kind: 'contact',
      title: contact.candidate.fn,
      allDay: false,
      tags: [],
      contact: contact.candidate,
      confidence: contact.confidence,
      chips: contact.chips,
      raw: input,
    }
  }

  let padded = input
  const chips: Chip[] = []
  const rec = scanRecurrence(input)
  if (rec !== undefined) {
    padded = blank(padded, rec.start, rec.end)
    chips.push({ start: rec.start, end: rec.end, text: input.slice(rec.start, rec.end), kind: 'recurrence' })
  }
  // Before the location scan: 'at cafe all day' must not swallow the words
  // into the place name.
  const ad = scanAllDay(input)
  if (ad !== undefined) {
    padded = blank(padded, ad.start, ad.end)
    // kind 'date' (not a new ChipKind): the palette's CHIP_CLASS is a closed
    // Record over the union, and 'all day' is date-shaped preview material.
    chips.push({ start: ad.start, end: ad.end, text: input.slice(ad.start, ad.end), kind: 'date' })
  }
  // Same pre-location ordering for the 'due' keyword: 'pay at bank due
  // friday' must not read 'due' into the place name. The keyword only
  // consumes itself when a date token directly follows; the date still comes
  // from the base pass.
  const dueWord = scanDueKeyword(input)
  if (dueWord !== undefined) {
    padded = blank(padded, dueWord.start, dueWord.end)
    chips.push({ start: dueWord.start, end: dueWord.end, text: input.slice(dueWord.start, dueWord.end), kind: 'date' })
  }
  const loc = scanLocation(padded)
  if (loc !== undefined) {
    padded = blank(padded, loc.start, loc.end)
    chips.push({ start: loc.start, end: loc.end, text: input.slice(loc.start, loc.end), kind: 'location' })
  }

  const base = parseQuickAddLine(padded)
  // Recurrence first occurrence: with a BYDAY rule and no explicitly typed
  // date, the base pass anchors the wall time to today — 'gym every monday
  // 7am' typed on a Wednesday previews Oct 14 while the saved series (RRULE
  // expansion from the DTSTART) starts Mon Oct 19. Roll the start forward to
  // the first BYDAY weekday (today counts, matching inclusive expansion) so
  // the palette preview, chips and the saved DTSTART agree. Non-BYDAY rules
  // (daily/monthly/yearly) and explicit date tokens keep the base date.
  if (rec !== undefined && base.dueOrStart !== undefined && !base.allDay) {
    const byday = /BYDAY=([A-Z,]+)/.exec(rec.rrule)
    const explicitDate = base.chips.some((c) => c.kind === 'date')
    if (byday !== null && !explicitDate) {
      const allowed = new Set(byday[1].split(','))
      const d = base.dueOrStart.date
      let add = 0
      while (
        add < 7 &&
        !allowed.has(BYDAY[new Date(d.getFullYear(), d.getMonth(), d.getDate() + add).getDay()])
      ) {
        add += 1
      }
      if (add > 0 && add < 7) {
        base.dueOrStart = {
          ...base.dueOrStart,
          date: new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, d.getHours(), d.getMinutes(), 0, 0),
        }
      }
    }
  }
  for (const c of base.chips) chips.push(c)
  chips.sort((a, b) => a.start - b.start || a.end - b.end)

  // Default kind: an EVENT as soon as any event-shaped signal parsed — a
  // clock time, a duration, a recurrence, a location, or an explicit
  // 'all day'. Only a bare line (or a date-only one, whose date reads as the
  // todo's due) stays a TODO: 'buy milk' and 'meet tomorrow' are dated
  // tasks, 'meet at 3pm' is an event. A forced 'todo:'/'event:'/'meet:'
  // prefix (same grammar as quickAdd's FORCED_PREFIX) pins the kind ahead
  // of this rule.
  const forcedKind = /^\s*(?:todo|task|event|meet|meeting)\s*:/i.test(input)
  const eventShaped =
    (base.dueOrStart !== undefined && !base.allDay) || // clock time
    base.durationMinutes !== undefined ||
    rec !== undefined ||
    loc !== undefined ||
    ad !== undefined
  const kind: InterpKind = forcedKind ? base.kind : eventShaped ? 'event' : base.kind
  const allDay = ad !== undefined || base.allDay

  const confidence: Interpretation['confidence'] =
    base.dueOrStart !== undefined && !base.allDay
      ? 'high'
      : rec !== undefined ||
          ad !== undefined ||
          base.durationMinutes !== undefined ||
          base.dueOrStart !== undefined
        ? 'medium'
        : 'low'

  return {
    kind,
    title: base.summary,
    when: base.dueOrStart !== undefined && !allDay ? base.dueOrStart.date : undefined,
    due: base.dueOrStart?.date,
    allDay,
    durationMin: base.durationMinutes,
    rrule: rec?.rrule,
    location: loc?.location,
    priority: base.priority,
    tags: base.tags,
    confidence,
    chips,
    raw: input,
  }
}
