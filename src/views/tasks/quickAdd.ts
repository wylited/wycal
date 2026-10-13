/**
 * Natural-language quick-add parser (Todoist's NL syntax, CONTRACTS §15):
 * recognizes due-date words ('today'/'tod'/'tomorrow'/'tom'/'tmr', weekdays
 * 'mon'…'sun' with 'next X' = one week out, 'in 3 days'/'in 2 weeks'/'in Nd',
 * 'oct 24'/'24 oct'/'10/24'), times ('at 5pm', '5:30pm', '17:00'), priority
 * ('#A'/'#B'/'#C' and '!p1'/'!p2'/'!p3' aliases) and '+tag' tokens — at any
 * position, case-insensitive — strips them from the summary and returns the
 * parsed fields. Pure module: no imports beyond `Date`.
 *
 * Composition: TasksView runs this pass FIRST and feeds the stripped remainder
 * through the org-syntax parser (./tasksModel `parseQuickAdd`) so `:tags:` /
 * `d:YYYY-MM-DD` / `d:+1w` keep working; when both passes match the same field
 * the natural-language match wins. Token table (all case-insensitive):
 *
 * | token                      | meaning                                        |
 * |----------------------------|------------------------------------------------|
 * | today, tod                 | today (all-day)                                |
 * | tomorrow, tom, tmr         | tomorrow (all-day)                             |
 * | mon…sun (full names too)   | next occurrence of that weekday (today counts) |
 * | next mon                   | one week past 'mon' when 'mon' hasn't already  |
 * |                            | wrapped into next week                          |
 * | in Nd / N day(s) / N       | N days from today (all-day)                    |
 * |   week(s)                  | N×7 days from today (all-day)                  |
 * | oct 24 / 24 oct (+ordinals)| that calendar date this year (all-day)         |
 * | 10/24                      | month/day this year (all-day)                  |
 * | at 5pm / 5pm / 5:30pm      | wall time merged into the matched date (today  |
 * | 17:00 / at 17:00           | when none) → timed due                         |
 * | #A / #B / #C               | priority 1 / 5 / 9                             |
 * | !p1 / !p2 / !p3            | priority 1 / 5 / 9                             |
 * | +tag                       | tag (must start with a letter, so '+1d' stays  |
 * |                            | text)                                          |
 *
 * Later matches of the same kind override earlier ones ('fri 10/24' → Oct 24);
 * a second date token replaces the first, a second time token replaces the
 * first time. Impossible dates ('feb 30', '13/45', '25pm') are left in the
 * summary untouched.
 *
 * `parseQuickAddLine` wraps the same token pass for the global quick-add
 * dialog (CONTRACTS §16 Q): a leading `todo:`/`task:`/`event:`/`meet:`/
 * `meeting:` prefix forces the kind; otherwise a parsed wall time or a
 * duration token ('30m', '1h', '1h30', '2 hours', 'for 45 min' — stripped
 * only in this line pass, so todo quick-adds keep '30m' as summary text)
 * implies a timed EVENT, and a date-only match or nothing implies a TODO.
 * Returns { kind, summary, dueOrStart, durationMinutes?, allDay, priority?,
 * tags }.
 */

/** One parsed due: the matched token text, the resolved local date, its form. */
export interface QuickAddDue {
  /** The literal matched text, e.g. 'next fri' or 'tomorrow at 5pm'. */
  text: string
  date: Date
  allDay: boolean
}

/**
 * One consumed NL token: where it sat in the ORIGINAL input line (absolute
 * [start, end) offsets) and what it parsed as. The command palette renders
 * these as highlighted live-preview chips (command/nl.ts interpret()); the
 * existing parseQuickAdd/parseQuickAddLine results are unchanged apart from
 * the additive `chips` on the line pass.
 */
export interface ParsedChip {
  start: number
  end: number
  /** The literal consumed text, e.g. 'next fri' or 'for 45m'. */
  text: string
  kind: 'date' | 'time' | 'duration' | 'priority' | 'tag'
}

/** One parsed quick-add (token pass): the todo-shaped fields TasksView uses. */
export interface ParsedQuickAdd {
  summary: string
  due?: QuickAddDue
  priority?: 1 | 5 | 9
  tags: string[]
}

/** What a quick-add line becomes: a calendar event or a task. */
export type QuickAddKind = 'event' | 'todo'

/** One parsed full quick-add line (dialog pass, CONTRACTS §16 Q). */
export interface ParsedQuickAddLine {
  kind: QuickAddKind
  summary: string
  /** The parsed date/time token (event start or todo due); undefined when
   *  the line carried no date at all. */
  dueOrStart?: QuickAddDue
  /** Duration token minutes ('30m', '1h', '1h30'); only parsed by this pass. */
  durationMinutes?: number
  /** Mirrors `dueOrStart?.allDay` (true when nothing was parsed). */
  allDay: boolean
  priority?: 1 | 5 | 9
  tags: string[]
  /** Consumed tokens in the caller's input coordinates (see ParsedChip). */
  chips: ParsedChip[]
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

/** JS getDay() numbers; keys cover 3-letter and full weekday names. */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Human hint for a parsed due: 'Fri Oct 16', + ' · 5:00pm' when timed. */
export function describeDue(due: { date: Date; allDay: boolean }): string {
  const d = due.date
  const label = `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
  if (due.allDay) return label
  const h24 = d.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const ampm = h24 < 12 ? 'am' : 'pm'
  return `${label} · ${h12}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`
}

/** Weekday due: plain = next occurrence (today counts); 'next X' = one week
 *  past that, unless the plain wrap already landed in next week (the weekday
 *  passed earlier this week) — then it IS next week's plain date. */
function weekdayDue(token: string, name: string, next: boolean): QuickAddDue | undefined {
  const target = WEEKDAYS[name]
  if (target === undefined) return undefined
  const now = new Date()
  let inDays = (target - now.getDay() + 7) % 7
  if (next) {
    const weekPos = (dow: number): number => (dow + 6) % 7 // Monday-first
    if (weekPos(target) >= weekPos(now.getDay())) inDays += 7
  }
  return { text: token.trim(), date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + inDays), allDay: true }
}

export function parseQuickAdd(input: string): ParsedQuickAdd {
  const t = parseTokens(input, false)
  return { summary: t.summary, due: t.due, priority: t.priority, tags: t.tags }
}

/** Internal token pass behind parseQuickAdd/parseQuickAddLine; `durations`
 *  additionally strips duration tokens (quick-add-line only, so the TasksView
 *  todo quick-add keeps '30m' as summary text — TODOs have no duration). */
interface TokenPass {
  summary: string
  due?: QuickAddDue
  priority?: 1 | 5 | 9
  tags: string[]
  /** A wall-time token matched (the due, else today, became timed). */
  hadTime: boolean
  durationMinutes?: number
  /** Consumed tokens in the caller's input coordinates, stripping order. */
  chips: ParsedChip[]
}

function parseTokens(input: string, durations: boolean, skip = 0): TokenPass {
  // A forced-kind prefix (skip > 0) is blanked rather than sliced away so
  // every chip offset below stays valid against the caller's full input.
  let summary = skip > 0 ? ' '.repeat(skip) + input.slice(skip) : input
  // offsets[i] = index in the caller's input of summary[i]; strip() keeps it
  // in sync as tokens are consumed (the palette's chip ranges read it).
  let offsets: number[] = Array.from(input, (_, i) => i)
  const chips: ParsedChip[] = []
  let dateText = ''
  let timeText = ''
  let due: QuickAddDue | undefined
  let priority: 1 | 5 | 9 | undefined
  let durationMinutes: number | undefined
  const tags: string[] = []

  /**
   * Remove every `re` match from the working summary, handing each match
   * (m[0] whole, m[1…] groups) to `on`; a `false` return rejects the match
   * and leaves its text in place. Accepted matches are recorded as chips of
   * `kind` with caller-input coordinates.
   */
  function strip(re: RegExp, on: (m: string[]) => boolean, kind: ParsedChip['kind']): void {
    const global = re.global ? re : new RegExp(re.source, `${re.flags}g`)
    // Collect first, then rewrite in one pass — String.replace would hand
    // every callback the same pre-strip string, and the offset map must be
    // rebuilt per accepted hit against that same working string anyway.
    const hits: { index: number; len: number; text: string; m: string[] }[] = []
    for (let h = global.exec(summary); h !== null; h = global.exec(summary)) {
      const m = h.slice() as string[]
      if (on(m)) hits.push({ index: h.index, len: h[0].length, text: h[0], m })
    }
    if (hits.length === 0) return
    let out = ''
    const outOffsets: number[] = []
    let cursor = 0
    for (const hit of hits) {
      out += summary.slice(cursor, hit.index) + ' '
      for (let i = cursor; i < hit.index; i++) outOffsets.push(offsets[i])
      outOffsets.push(offsets[hit.index])
      chips.push({ start: offsets[hit.index], end: offsets[hit.index + hit.len - 1] + 1, text: hit.text, kind })
      cursor = hit.index + hit.len
    }
    out += summary.slice(cursor)
    for (let i = cursor; i < offsets.length; i++) outOffsets.push(offsets[i])
    summary = out
    offsets = outOffsets
  }

  /** All-day due N days out (huge N rolls past the Date range → rejected). */
  function inDays(n: number, text: string): boolean {
    const now = new Date()
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)
    if (!Number.isFinite(date.getTime())) return false
    dateText = text
    due = { text, date, allDay: true }
    return true
  }

  /** Calendar-date due this year; impossible dates (2026-02-31) rejected. */
  function onDate(month: number, day: number, text: string): boolean {
    const now = new Date()
    const date = new Date(now.getFullYear(), month - 1, day)
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return false
    dateText = text
    due = { text, date, allDay: true }
    return true
  }

  /** Merge a wall time into the matched date (today when none) → timed due. */
  function atTime(hourIn: number, minute: number, suffix: 'am' | 'pm' | undefined, text: string): boolean {
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false
    let hour = hourIn
    if (suffix !== undefined) {
      if (hourIn < 1 || hourIn > 12) return false
      hour = (hourIn % 12) + (suffix === 'pm' ? 12 : 0)
    } else if (hourIn < 0 || hourIn > 23) return false
    const now = new Date()
    const date = due !== undefined ? new Date(due.date) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
    date.setHours(hour, minute, 0, 0)
    timeText = text
    due = { text: '', date, allDay: false }
    return true
  }

  // Priority: '#A'/'#B'/'#C' and the '!p1'/'!p2'/'!p3' aliases (last wins).
  strip(/\B#([abc])\b/gi, (m) => {
    const letter = (m[1] as string).toLowerCase()
    priority = letter === 'a' ? 1 : letter === 'b' ? 5 : 9
    return true
  }, 'priority')
  strip(/!p([123])\b/gi, (m) => {
    priority = m[1] === '1' ? 1 : m[1] === '2' ? 5 : 9
    return true
  }, 'priority')

  // '+tag' tokens → tags; a leading letter keeps '+1d' and friends as text.
  strip(/\+([A-Za-z][\w-]*)/g, (m) => {
    const tag = m[1] as string
    if (!tags.includes(tag)) tags.push(tag)
    return true
  }, 'tag')

  // 'in 3 days' / 'in 2 weeks' / 'in 5d'.
  strip(/\bin\s+(\d{1,3})\s*(d|day|days|w|week|weeks)\b/gi, (m) => {
    const n = Number(m[1])
    const unit = (m[2] as string).toLowerCase()
    return inDays(unit.startsWith('w') ? n * 7 : n, m[0] as string)
  }, 'date')

  // 'today'/'tod'/'tomorrow'/'tom'/'tmr'.
  strip(/\b(today|tod|tomorrow|tom|tmr)\b/gi, (m) => inDays(/^(today|tod)$/i.test(m[1] as string) ? 0 : 1, m[0] as string), 'date')

  // Weekdays, bare or 'next'-prefixed (full names listed before abbreviations).
  strip(
    /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/gi,
    (m) => {
      const d = weekdayDue(m[0] as string, m[2] as string, m[1] !== undefined)
      if (d === undefined) return false
      dateText = d.text
      due = d
      return true
    },
    'date',
  )

  // '10/24' — month/day this year.
  strip(/\b(\d{1,2})\/(\d{1,2})\b/g, (m) => onDate(Number(m[1]), Number(m[2]), m[0] as string), 'date')

  // 'oct 24' / 'oct 24th' …
  strip(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi,
    (m) => onDate(MONTHS[(m[1] as string).toLowerCase()], Number(m[2]), m[0] as string),
    'date',
  )

  // … and '24 oct' / '24th oct'.
  strip(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/gi,
    (m) => onDate(MONTHS[(m[2] as string).toLowerCase()], Number(m[1]), m[0] as string),
    'date',
  )

  // Times, 24h first ('17:00', 'at 9:15'), then 12h ('at 5pm', '5:30pm') —
  // both merge into the matched date and make the due timed.
  strip(/\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi, (m) =>
    atTime(Number(m[1]), Number(m[2]), m[3] !== undefined ? ((m[3] as string).toLowerCase() as 'am' | 'pm') : undefined, m[0] as string), 'time')
  strip(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (m) =>
    atTime(Number(m[1]), m[2] === undefined ? 0 : Number(m[2]), (m[3] as string).toLowerCase() as 'am' | 'pm', m[0] as string), 'time')

  // Durations ('1h', '1h30m', '2 hours', '30m', '90 min', 'for 45m') — hours
  // forms first so they can't be half-eaten by the bare-minutes form; 'for N
  // <unit>' and bare 'N<unit>' both count. Zero and >24h stay text.
  if (durations) {
    // '1h', '1h30m', '2 hours', '2h 15m' — optional glued/separated minutes.
    strip(/\b(?:for\s+)?(\d{1,3})\s*(?:hours?|hrs?|h)\s*(?:(\d{1,2})\s*(?:m|min|mins|minutes?))?\b/gi, (m) => {
      const h = Number(m[1])
      const min = m[2] === undefined ? 0 : Number(m[2])
      const mins = h * 60 + min
      if (h > 23 || min > 59 || mins === 0 || mins > 24 * 60) return false
      durationMinutes = mins
      return true
    }, 'duration')
    // '1h30' / '2 hours 30' — trailing minutes with no unit (the form above
    // needs one, so its \b would reject these; runs after it, so '1h30m' is
    // already gone).
    strip(/\b(?:for\s+)?(\d{1,3})\s*(?:hours?|hrs?|h)\s*(\d{1,2})\b/gi, (m) => {
      const h = Number(m[1])
      const min = Number(m[2])
      const mins = h * 60 + min
      if (h > 23 || min > 59 || mins === 0 || mins > 24 * 60) return false
      durationMinutes = mins
      return true
    }, 'duration')
    strip(/\b(?:for\s+)?(\d{1,3})\s*(?:minutes?|mins?|m)\b/gi, (m) => {
      const mins = Number(m[1])
      if (mins === 0 || mins > 24 * 60) return false
      durationMinutes = mins
      return true
    }, 'duration')
  }

  if (due !== undefined) due.text = [dateText, timeText].filter((t) => t !== '').join(' ')
  // Collapse the gaps left by stripped tokens; tidy space-before-punctuation
  // and dangling edge separators.
  summary = summary
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[,;:.\s]+/, '')
    .replace(/[,;:\s]+$/, '')
    .trim()
  return { summary, due, priority, tags, hadTime: timeText !== '', durationMinutes, chips }
}

/** Forced-kind prefixes: 'todo:'/'task:' → todo, 'event:'/'meet:'/'meeting:'
 *  → event (case-insensitive, start of the trimmed line). */
const FORCED_PREFIX = /^\s*(todo|task|event|meet|meeting)\s*:/i

/**
 * Full-line parse for the global quick-add dialog (CONTRACTS §16 Q): the
 * forced-kind prefix wins; otherwise a parsed wall time or a duration token
 * implies a timed EVENT (weekday + time pairs land here too), a date-only
 * match or nothing implies a TODO. All todo tokens (dates, times, priorities,
 * +tags) behave exactly as in parseQuickAdd; the summary comes back with
 * every recognized token stripped, and `chips` records each consumed token's
 * span in the caller's input coordinates (command/nl.ts live preview).
 */
export function parseQuickAddLine(input: string): ParsedQuickAddLine {
  let forced: QuickAddKind | undefined
  const m = FORCED_PREFIX.exec(input)
  if (m !== null) {
    forced = /^(todo|task)$/i.test(m[1]) ? 'todo' : 'event'
  }
  // The forced prefix is blanked inside parseTokens (skip), so chip offsets
  // stay valid against the full input line.
  const t = parseTokens(input, true, m === null ? 0 : m[0].length)
  return {
    kind: forced ?? (t.hadTime || t.durationMinutes !== undefined ? 'event' : 'todo'),
    summary: t.summary,
    dueOrStart: t.due,
    durationMinutes: t.durationMinutes,
    allDay: t.due?.allDay ?? true,
    priority: t.priority,
    tags: t.tags,
    chips: t.chips,
  }
}
