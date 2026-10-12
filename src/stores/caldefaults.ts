/**
 * Per-calendar default event settings (CONTRACTS §12): repeat preset,
 * duration, reminder and event color keyed by collection URL, persisted to
 * localStorage 'wycal.caldefaults'. Pure UI preferences — no DAV traffic;
 * the editor (§17) and sidebar popover (§18) read/write these.
 */
import { signal } from '@preact/signals'

interface CalDefaults {
  /** RRULE preset id (the editor repeat select), e.g. 'weekly'. */
  repeat?: string
  durationMin?: number
  reminder?: string
  eventColor?: string
}

type CalDefaultsPatch = Partial<CalDefaults>

const CALDEFAULTS_STORAGE_KEY = 'wycal.caldefaults'

/** Shared frozen empty result — `getCalDefaults` never allocates. */
const EMPTY_DEFAULTS: CalDefaults = {}

function isCalDefaults(v: unknown): v is CalDefaults {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    (r.repeat === undefined || typeof r.repeat === 'string') &&
    (r.durationMin === undefined || typeof r.durationMin === 'number') &&
    (r.reminder === undefined || typeof r.reminder === 'string') &&
    (r.eventColor === undefined || typeof r.eventColor === 'string')
  )
}

function loadCalDefaults(): Record<string, CalDefaults> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CALDEFAULTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, CalDefaults> = {}
    for (const [url, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isCalDefaults(v)) out[url] = v
    }
    return out
  } catch (err) {
    console.warn('wycal: could not read calendar defaults, using none', err)
    return {}
  }
}

/** Defaults per calendar URL, persisted to 'wycal.caldefaults'. */
const calDefaults = signal<Record<string, CalDefaults>>(loadCalDefaults())

function persist(): void {
  try {
    localStorage.setItem(CALDEFAULTS_STORAGE_KEY, JSON.stringify(calDefaults.value))
  } catch (err) {
    console.warn('wycal: could not persist calendar defaults', err)
  }
}

/** Defaults for one calendar; `{}` when unset. */
export function getCalDefaults(url: string): CalDefaults {
  return calDefaults.value[url] ?? EMPTY_DEFAULTS
}

/** Merge a patch into one calendar's defaults; `undefined` values clear a key. */
export function setCalDefaults(url: string, patch: CalDefaultsPatch): void {
  const next: CalDefaults = { ...calDefaults.value[url], ...patch }
  for (const k of Object.keys(next) as (keyof CalDefaults)[]) {
    if (next[k] === undefined) delete next[k]
  }
  const map = { ...calDefaults.value }
  if (Object.keys(next).length === 0) delete map[url]
  else map[url] = next
  calDefaults.value = map
  persist()
}
