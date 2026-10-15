/** @jsxImportSource preact */
/**
 * Sidebar search (§nav-revamp): the always-visible box near the top of the
 * sidebar (under the unified New-item button), replacing the `#/search`
 * centered overlay. Same engine (searchEngine.ts matchUniverse + token
 * grammar) and the same row components as the old view
 * (SearchMatchView.tsx), plus a contacts group (plain text match over
 * fn/org/title/note/emails/tels). Rows expand in place: a click toggles an
 * inline detail card (range/location/description for events, due/priority/
 * tags/note for tasks, emails/tels/org/note for contacts) and navigation
 * moved to the cards' explicit Open buttons (schedule date patch / agenda
 * mode / requestOpenContact in Contacts mode). Only one row per list is
 * open at a time; Esc collapses.
 * Results are scoped to the shell mode: events in schedule, todos in agenda,
 * contacts in contacts. A non-empty query takes over the whole sidebar
 * column — the shell hides its section stack while active. Esc clears.
 * (Keyboard search entry lives in the command palette: '/' + ⌘K.)
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Vcard } from '@wycal/core/lib/vcard/types'
import { dayKey } from '@wycal/core/lib/util/date'
import { gotoCalendarQuery } from '../../routes'
import { contacts, requestOpenContact } from '@wycal/core/stores/contacts'
import { Icon } from '../../ui/icons'
import { filterMatchItems, matchUniverse, tokenToText, tokenizeQuery } from '@wycal/core/search/searchEngine'
import type { MatchItem } from '@wycal/core/search/searchEngine'
import { DetailField, MatchResults, RowDetail, snippet } from './SearchMatchView'

/** One sidebar contact hit: record href + display strings + the record data
 *  behind the expanded detail card (emails/tels/org/title/note). */
interface ContactHit {
  href: string
  fn: string
  detail: string
  data: Vcard
}

/** Text tokens of a query (contacts ignore the keyword grammar). */
function textTokens(query: string): string[] {
  const { tokens, error } = tokenizeQuery(query)
  if (error) return []
  const out: string[] = []
  for (const t of tokens) {
    if (t.kind !== 'text') continue
    out.push(t.value.toLowerCase())
  }
  return out
}

/** Every token must appear in the card's searchable text (case-insensitive). */
function contactMatches(
  data: {
    fn: string
    org?: string
    title?: string
    note?: string
    emails: { value: string }[]
    tels: { value: string }[]
  },
  tokens: string[],
): boolean {
  if (tokens.length === 0) return false
  const hay = [
    data.fn,
    data.org ?? '',
    data.title ?? '',
    data.note ?? '',
    ...data.emails.map((e) => e.value),
    ...data.tels.map((t) => t.value),
  ]
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => hay.includes(t))
}

/** Sidebar-top search box + inline grouped results. */
export default function SidebarSearch(props: {
  mode: 'schedule' | 'agenda' | 'contacts'
  onNavigate?: () => void
  onActiveChange?: (active: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const [debounced, setDebounced] = useState('')
  const [openContactHref, setOpenContactHref] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ~150ms debounce, mirroring the old search view (perf P5).
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(draft), 150)
    return () => window.clearTimeout(t)
  }, [draft])

  const { tokens, error } = tokenizeQuery(debounced)
  const matches: MatchItem[] =
    error || !debounced.trim() ? [] : filterMatchItems(matchUniverse.value, tokens)
  const contactTokens = textTokens(debounced)
  const contactHits: ContactHit[] =
    error || contactTokens.length === 0
      ? []
      : [...contacts.value.values()]
          .filter((rec) => contactMatches(rec.data, contactTokens))
          .slice(0, 20)
          .map((rec) => ({
            href: rec.href,
            fn: rec.data.fn,
            detail: rec.data.emails[0]?.value ?? rec.data.org ?? rec.data.title ?? '',
            data: rec.data,
          }))
  const hasQuery = !error && debounced.trim() !== ''

  // Report takeover state: the shell hides its section stack while a query
  // is active so results can use the full sidebar height.
  useEffect(() => {
    props.onActiveChange?.(hasQuery)
  }, [hasQuery])

  const placeholder =
    props.mode === 'schedule' ? 'Search events…' : props.mode === 'agenda' ? 'Search tasks…' : 'Search contacts…'

  /** Tag chip click in a todo row: swap in `tag:<x>` keeping other tokens. */
  function setTagToken(tag: string): void {
    const kept = tokenizeQuery(draft).tokens.filter((t) => t.kind !== 'tag').map(tokenToText)
    kept.push(`tag:${tag}`)
    setDraft(kept.join(' '))
  }

  /** Detail-card Open: events land the schedule on the occurrence day (hash
   *  date patch, same as MiniMonth/MiniAgenda navigation), todos switch to
   *  the agenda mode; either way the mobile drawer closes via onNavigate. */
  function openMatch(item: MatchItem): void {
    if (item.kind === 'event') gotoCalendarQuery({ date: dayKey(item.when) })
    else gotoCalendarQuery({ view: 'agenda' })
    props.onNavigate?.()
  }

  /** Open-contact button: Contacts mode + the detail popover for that card. */
  function openContact(href: string): void {
    requestOpenContact(href)
    window.location.hash = '/contacts'
    props.onNavigate?.()
  }

  return (
    <div class={`sb-search px-3 pt-3 pb-1 ${hasQuery ? 'sb-search-active flex min-h-0 flex-1 flex-col' : ''}`}>
      <input
        ref={inputRef}
        class="input w-full"
        type="search"
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft('')
            setDebounced('')
          }
        }}
      />
      {hasQuery && (
        <div class={`sb-search-results mt-1 min-h-0 overflow-y-auto${hasQuery ? ' flex-1' : ''}`}>
          {props.mode === 'schedule' && (
            <MatchResults only="events" items={matches} onTagClick={setTagToken} expandable onOpen={openMatch} />
          )}
          {props.mode === 'contacts' && (
            <div
              class="sb-search-group"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && openContactHref !== null) {
                  e.stopPropagation()
                  setOpenContactHref(null)
                }
              }}
            >
              <div class="sb-search-group-head">Contacts</div>
              {contactHits.map((c) => {
                const open = openContactHref === c.href
                return (
                  <div key={c.href} class="flex flex-col">
                    <button
                      type="button"
                      class="sb-contact-row"
                      title={open ? undefined : 'Click for details'}
                      aria-expanded={open}
                      onClick={() => setOpenContactHref((h) => (h === c.href ? null : c.href))}
                    >
                      <span class="min-w-0 truncate text-fg-strong">{c.fn}</span>
                      {c.detail && <span class="min-w-0 truncate text-xs text-muted">{c.detail}</span>}
                    </button>
                    {open && (
                      <RowDetail openLabel="Open contact" onOpen={() => openContact(c.href)}>
                        {c.data.emails.length > 0 && (
                          <div class="flex flex-col gap-1">
                            {c.data.emails.map((e, i) => (
                              <div key={i} class="flex items-center gap-1.5 text-xs">
                                <Icon.mail size={13} class="shrink-0 text-muted" />
                                <span class="truncate text-fg">{e.value}</span>
                                {e.types.length > 0 && (
                                  <span class="shrink-0 text-[10px] text-muted">{e.types.join(', ')}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {c.data.tels.length > 0 && (
                          <div class="flex flex-col gap-1">
                            {c.data.tels.map((t, i) => (
                              <div key={i} class="flex items-center gap-1.5 text-xs">
                                <Icon.phone size={13} class="shrink-0 text-muted" />
                                <span class="truncate text-fg">{t.value}</span>
                                {t.types.length > 0 && (
                                  <span class="shrink-0 text-[10px] text-muted">{t.types.join(', ')}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {(c.data.org !== undefined || c.data.title !== undefined) && (
                          /* ORG 'Acme;Design' → 'Acme, Design' (displayOrg convention). */
                          <p class="break-words text-xs text-muted">
                            {[(c.data.org ?? '').split(';').filter(Boolean).join(', '), c.data.title]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
                        {c.data.note && <DetailField label="Note" text={snippet(c.data.note)} />}
                      </RowDetail>
                    )}
                  </div>
                )
              })}
              {contactHits.length === 0 && <p class="px-2.5 py-1 text-xs text-muted">No matching contacts.</p>}
            </div>
          )}
          {props.mode === 'agenda' && (
            <MatchResults only="todos" items={matches} onTagClick={setTagToken} expandable onOpen={openMatch} />
          )}
        </div>
      )}
    </div>
  )
}
