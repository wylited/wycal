/** @jsxImportSource preact */
/**
 * Contacts sidebar sections (design.md §5): tag filter + upcoming birthdays.
 * Rendered inside the app Sidebar's contacts mode by shell/Sidebar.tsx.
 * Self-contained (no props): reads the contacts store + the shared signals
 * in stores/contacts (contactTagFilter drives the main list's AND filter,
 * requestOpenContact opens the detail popover in the main view). Contact
 * creation lives in the sidebar's unified New-item button, which dispatches
 * the `wycal:newcontact` window event ContactsView listens for.
 */
import { useMemo } from 'preact/hooks'
import { contacts, contactTagFilter, requestOpenContact } from '@wycal/core/stores/contacts'
import { syncState } from '@wycal/core/lib/sync/engine'

/** How far ahead the birthday list looks (days, inclusive of today). */
const BIRTHDAY_WINDOW_DAYS = 30

/** One birthday row: contact href + display fields. */
interface BirthdayRow {
  href: string
  name: string
  date: Date
}

/**
 * BDAY → { month, day }, mirroring the engine's accepted shapes
 * (lib/sync/engine birthdayDateOf): `YYYY-MM-DD…`, `--MM-DD`, the RFC 6350
 * reduced form `--MMDD`, and vCard 3.0 basic `YYYYMMDD`. Text values → null.
 */
function bdayMonthDay(bday: string | undefined): { month: number; day: number } | null {
  if (bday === undefined) return null
  const s = bday.trim()
  let m = /^\d{4}-(\d{2})-(\d{2})/.exec(s) ?? /^--(\d{2})-(\d{2})/.exec(s)
  if (m) return { month: +m[1], day: +m[2] }
  m = /^--(\d{2})(\d{2})/.exec(s)
  if (m) return { month: +m[1], day: +m[2] }
  m = /^\d{4}(\d{2})(\d{2})$/.exec(s)
  if (m) return { month: +m[1], day: +m[2] }
  return null
}

/** Next occurrence of (month, day) on/after `from`, rolling into next year. */
function nextOccurrence(month: number, day: number, from: Date): Date {
  const year = from.getFullYear()
  const candidate = new Date(year, month - 1, day)
  if (candidate >= from) return candidate
  return new Date(year + 1, month - 1, day)
}

/** Contacts with a parsable BDAY inside the next BIRTHDAY_WINDOW_DAYS, soonest first. */
function useUpcomingBirthdays(): BirthdayRow[] {
  return useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const rows: BirthdayRow[] = []
    for (const rec of contacts.value.values()) {
      const md = bdayMonthDay(rec.data.bday)
      if (md === null) continue
      const date = nextOccurrence(md.month, md.day, today)
      const days = Math.round((date.getTime() - today.getTime()) / 86400000)
      if (days > BIRTHDAY_WINDOW_DAYS) continue
      rows.push({ href: rec.href, name: rec.data.fn || 'Unnamed', date })
    }
    rows.sort((a, b) => a.date.getTime() - b.date.getTime())
    return rows
  }, [contacts.value])
}

/** Union of all contacts' CATEGORIES tags, alphabetical. */
function useAllTags(): string[] {
  return useMemo(() => {
    const tags = new Set<string>()
    for (const rec of contacts.value.values()) {
      for (const t of rec.data.categories) tags.add(t)
    }
    return [...tags].sort((a, b) => a.localeCompare(b))
  }, [contacts.value])
}

function toggleTag(tag: string): void {
  const active = contactTagFilter.value
  contactTagFilter.value = active.includes(tag)
    ? active.filter((t) => t !== tag)
    : [...active, tag]
}

/**
 * Contacts-mode sidebar sections. Sized by the same `.chip` rules the rest of
 * the sidebar uses, so prefs.sidebarSize (compact/large) applies automatically.
 */
export default function ContactsSidebar() {
  const tags = useAllTags()
  const birthdays = useUpcomingBirthdays()
  const active = contactTagFilter.value
  const syncing = [...syncState.value.values()].some((s) => s.state === 'syncing')

  return (
    <div class="flex flex-col gap-3 px-2 py-2">
      {tags.length > 0 && (
        <section aria-label="Contact tags" class="flex flex-col gap-1">
          <div class="flex items-center gap-1">
            <span class="text-xs font-semibold text-muted">Tags</span>
            <span class="min-w-0 flex-1" />
            {active.length > 0 && (
              <button
                type="button"
                class="rounded-sm px-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
                onClick={() => (contactTagFilter.value = [])}
                title="Clear tag filter"
              >
                Clear
              </button>
            )}
          </div>
          <div class="chip-row gap-1">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                class="chip shrink-0 whitespace-nowrap"
                aria-pressed={active.includes(tag)}
                title={active.includes(tag) ? `Stop filtering by “${tag}”` : `Filter by “${tag}”`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </section>
      )}

      {birthdays.length > 0 && (
        <section aria-label="Upcoming birthdays" class="flex flex-col gap-1">
          <span class="text-xs font-semibold text-muted">Birthdays · next 30 days</span>
          {birthdays.map((row) => (
            <button
              key={row.href}
              type="button"
              class="chip w-full justify-start"
              title={`Open ${row.name}`}
              onClick={() => requestOpenContact(row.href)}
            >
              <span class="min-w-0 flex-1 truncate">
                {row.name} ·{' '}
                {row.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
            </button>
          ))}
        </section>
      )}

      {syncing && (
        <p class="px-1 text-xs text-muted" role="status">
          Syncing contacts…
        </p>
      )}
    </div>
  )
}
