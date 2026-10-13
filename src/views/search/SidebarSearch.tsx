/** @jsxImportSource preact */
/**
 * Sidebar search (§nav-revamp): the always-visible box near the top of the
 * sidebar (under the unified New-item button), replacing the `#/search`
 * centered overlay. Same engine (searchEngine.ts matchUniverse + token
 * grammar) and the same row components as the old view
 * (SearchMatchView.tsx), plus a contacts group (plain text match over
 * fn/org/title/note/emails/tels; click opens the contact detail popover in
 * Contacts mode via requestOpenContact).
 * Results are scoped to the shell mode: events in schedule, todos in agenda,
 * contacts in contacts. A non-empty query takes over the whole sidebar
 * column — the shell hides its section stack while active.
 * '/' and ⌘K focus the box via the `wycal:search` window ping (dispatched by
 * app.tsx §16); Esc clears.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { contacts, requestOpenContact } from '../../stores/contacts'
import { filterMatchItems, matchUniverse, tokenToText, tokenizeQuery } from './searchEngine'
import type { MatchItem } from './searchEngine'
import { MatchResults } from './SearchMatchView'

/** One sidebar contact hit: record href + display strings. */
interface ContactHit {
  href: string
  fn: string
  detail: string
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
  const inputRef = useRef<HTMLInputElement>(null)

  // '/' / ⌘K (app.tsx §16) focus the box via the shared route-view ping.
  useEffect(() => {
    const onSearch = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('wycal:search', onSearch)
    return () => window.removeEventListener('wycal:search', onSearch)
  }, [])

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

  /** Contact row click: Contacts mode + the detail popover for that card. */
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
          {props.mode === 'schedule' && <MatchResults only="events" items={matches} onTagClick={setTagToken} />}
          {props.mode === 'contacts' && (
            <div class="sb-search-group">
              <div class="sb-search-group-head">Contacts</div>
              {contactHits.map((c) => (
                <button
                  key={c.href}
                  type="button"
                  class="sb-contact-row"
                  title={c.detail ? `${c.fn} — ${c.detail}` : c.fn}
                  onClick={() => openContact(c.href)}
                >
                  <span class="min-w-0 truncate text-fg-strong">{c.fn}</span>
                  {c.detail && <span class="min-w-0 truncate text-xs text-muted">{c.detail}</span>}
                </button>
              ))}
              {contactHits.length === 0 && <p class="px-2.5 py-1 text-xs text-muted">No matching contacts.</p>}
            </div>
          )}
          {props.mode === 'agenda' && <MatchResults only="todos" items={matches} onTagClick={setTagToken} />}
        </div>
      )}
    </div>
  )
}
