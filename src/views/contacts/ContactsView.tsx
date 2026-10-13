/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { contactTagFilter, contacts, openContactRequest } from '../../stores/contacts'
import type { ContactRecord } from '../../stores/contacts'
import { collections } from '../../stores/calendars'
import { syncState } from '../../lib/sync/engine'
import type { Vcard } from '../../lib/vcard/types'
import { Icon } from '../../ui/icons'
import { ContactEditor } from './ContactEditor'
import { ContactAvatar, ContactDetailPopover, displayOrg } from './ContactDetailPopover'

/** Contacts pane (design.md §5): search, card grid, click-to-inspect popover.
 *  Contact creation lives solely in the sidebar's unified New-item button
 *  (it dispatches `wycal:newcontact`, handled below) — no main-view duplicate. */
export function ContactsView() {
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<{ href: string; anchor: HTMLElement } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ContactRecord | null>(null)
  /** Scroll body of the contact grid — anchor for signal-raised popovers. */
  const listBodyRef = useRef<HTMLDivElement | null>(null)

  // Memoized identity sort: reruns only when the contacts store map swaps,
  // not on every search keystroke (signal read during render = reactive).
  const all = useMemo(
    () => [...contacts.value.values()].sort((a, b) => a.data.fn.localeCompare(b.data.fn)),
    [contacts.value],
  )
  const q = query.trim().toLowerCase()
  // Sidebar tag filter is AND: a contact must carry every active tag. The
  // search box stacks on top of it.
  const activeTags = contactTagFilter.value
  const list = all.filter(
    (r) => activeTags.every((t) => r.data.categories.includes(t)) && (q === '' || matches(r.data, q)),
  )
  const syncing = [...syncState.value.values()].some((s) => s.state === 'syncing')
  const addressbookUrl = collections.value.find((c) => c.kind === 'addressbook')?.url
  // Live lookup: an edit/delete swaps the contacts Map, so the popover (and
  // its `selected` highlight) always render from current data; a deleted
  // record resolves to undefined and the popover unmounts.
  const detailRec = detail !== null ? contacts.value.get(detail.href) : undefined

  // Global `c` (app.tsx) navigates here and pings 'wycal:newcontact' — open
  // the create editor. The command palette attaches a prefill candidate
  // ({fn, email?, tel?}) in the event detail.
  const [createPrefill, setCreatePrefill] = useState<{ fn: string; email?: string; tel?: string } | null>(null)
  useEffect(() => {
    const onNewContact = (e: Event): void => {
      const prefill = (e as CustomEvent).detail?.prefill as { fn: string; email?: string; tel?: string } | undefined
      setCreatePrefill(prefill ?? null)
      setEditing(null)
      setEditorOpen(true)
    }
    window.addEventListener('wycal:newcontact', onNewContact)
    return () => window.removeEventListener('wycal:newcontact', onNewContact)
  }, [])

  // Sidebar birthdays + note @mentions raise requestOpenContact — open the
  // detail popover anchored to the list body (no card anchor exists outside
  // the grid), then consume the one-shot request. Unknown/deleted hrefs and
  // a missing anchor are dropped silently.
  useEffect(() => {
    const req = openContactRequest.value
    if (req === null) return
    openContactRequest.value = null
    if (listBodyRef.current === null || !contacts.value.has(req.href)) return
    setDetail({ href: req.href, anchor: listBodyRef.current })
  }, [openContactRequest.value])

  /** Click-to-inspect (§22 pattern): anchor the detail popover to the card. */
  function openDetail(record: ContactRecord, anchor: HTMLElement): void {
    setDetail({ href: record.href, anchor })
  }

  /** Open the existing ContactEditor for `record`; any detail popover yields. */
  function openEdit(record: ContactRecord): void {
    setDetail(null)
    setEditing(record)
    setEditorOpen(true)
  }

  let body: ComponentChildren
  if (all.length === 0 && syncing) {
    body = (
      <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        <p class="sr-only">Loading contacts…</p>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} class="card flex items-center gap-3" aria-hidden="true">
            <div class="h-10 w-10 shrink-0 animate-pulse rounded-full bg-surface-2" />
            <div class="min-w-0 flex-1 space-y-2">
              <div class="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
              <div class="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    )
  } else if (all.length === 0) {
    body = (
      <div class="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <Icon.users size={24} />
        <p class="text-sm">
          {addressbookUrl === undefined
            ? 'Connect an account with an address book to add contacts'
            : 'No contacts yet — use “New contact” in the sidebar'}
        </p>
      </div>
    )
  } else if (list.length === 0) {
    const tagFiltered = activeTags.length > 0
    body = (
      <div class="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <Icon.search size={24} />
        <p class="text-sm">
          {tagFiltered
            ? `No contacts tagged ${activeTags.map((t) => `“${t}”`).join(' + ')}${q !== '' ? ` matching “${query.trim()}”` : ''}`
            : `No contacts match “${query.trim()}”`}
        </p>
        {tagFiltered && (
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => (contactTagFilter.value = [])}
          >
            Clear tag filter
          </button>
        )}
      </div>
    )
  } else {
    body = (
      <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {list.map((record) => (
          <ContactCard
            key={record.href}
            record={record}
            selected={record.href === detail?.href}
            onClick={(anchor) => openDetail(record, anchor)}
            onDblClick={() => openEdit(record)}
          />
        ))}
      </div>
    )
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex items-center gap-3 border-b border-border px-4 py-2">
        <div class="relative w-full max-w-60">
          <Icon.search size={14} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            class="input pl-8"
            placeholder="Search contacts"
            aria-label="Search contacts"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>
      <div class="flex min-h-0 flex-1">
        <div ref={listBodyRef} class="min-w-0 flex-1 overflow-y-auto p-4">{body}</div>
        {detail !== null && detailRec !== undefined && (
          <ContactDetailPopover
            key={detailRec.href}
            record={detailRec}
            anchor={detail.anchor}
            onEdit={() => openEdit(detailRec)}
            onClose={() => setDetail(null)}
          />
        )}
      </div>
      <ContactEditor
        open={editorOpen}
        record={editing}
        addressbookUrl={addressbookUrl ?? ''}
        initial={editing === null ? (createPrefill ?? undefined) : undefined}
        onClose={() => setEditorOpen(false)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function ContactCard(props: {
  record: ContactRecord
  selected: boolean
  onClick: (anchor: HTMLElement) => void
  onDblClick: () => void
}) {
  const v = props.record.data
  const meta = displayOrg(v) || v.title
  const email = v.emails[0]?.value
  const tel = v.tels[0]?.value
  return (
    <button
      type="button"
      class="card flex items-center gap-3 text-left transition-colors hover:bg-surface-2"
      aria-pressed={props.selected}
      title={`${v.fn || 'Unnamed'} (double-click to edit)`}
      onClick={(e) => props.onClick(e.currentTarget as HTMLElement)}
      onDblClick={props.onDblClick}
    >
      <ContactAvatar v={v} />
      <div class="min-w-0 flex-1">
        <div class="truncate font-medium text-fg-strong">{v.fn || 'Unnamed'}</div>
        {meta !== '' && <div class="mt-0.5 truncate text-sm text-muted">{meta}</div>}
        {email !== undefined && email !== '' && (
          <div class="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
            <Icon.mail size={14} class="shrink-0" />
            <span class="truncate">{email}</span>
          </div>
        )}
        {tel !== undefined && tel !== '' && (
          <div class="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
            <Icon.phone size={14} class="shrink-0" />
            <span class="truncate">{tel}</span>
          </div>
        )}
        {v.categories.length > 0 && (
          <div class="mt-1.5 flex flex-wrap gap-1">
            {v.categories.slice(0, 3).map((t, i) => (
              <span key={`${t}-${i}`} class="hint-chip max-w-36 truncate" title={t}>
                {t}
              </span>
            ))}
            {v.categories.length > 3 && <span class="hint-chip">+{v.categories.length - 3}</span>}
          </div>
        )}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------

/** Case-insensitive `contains` across FN, ORG, EMAIL, TEL and CATEGORIES values. */
function matches(v: Vcard, q: string): boolean {
  const hay = [v.fn, v.org ?? '', ...v.categories, ...v.emails.map((e) => e.value), ...v.tels.map((t) => t.value)]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}
