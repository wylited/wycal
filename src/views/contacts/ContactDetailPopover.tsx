/** @jsxImportSource preact */
/**
 * Contact detail popover (§22 pattern, mirrors EventDetailPopover): a single
 * click on a contact card opens this compact card instead of the editor —
 * the "who was this again" check stays one click, the full editor moves
 * behind Edit (double-click edits directly). Anchored to the clicked element,
 * viewport-clamped, .card chrome. Closes on Esc and outside click; registers
 * with the global dialog gate (stores/ui) while mounted so global shortcuts
 * are suppressed. Delete is the two-step confirm; the contacts store has no
 * undo capture, so there is no undo toast (unlike events/todos).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { deleteContact } from '@wycal/core/stores/contacts'
import type { ContactRecord } from '@wycal/core/stores/contacts'
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui'
import { PALETTE, hexToRgba } from '@wycal/core/lib/util/colors'
import type { Vcard } from '@wycal/core/lib/vcard/types'
import { Icon } from '../../ui/icons'

const WIDTH = 340

/**
 * Two-step delete confirm, same pattern as the event/todo popovers and the
 * editors (CONTRACTS §21): the first `activate` arms — the Delete button
 * turns into danger 'Sure?' — the second deletes; a 3s timer reverts.
 * File-local to the views owning delete affordances.
 */
function useConfirmDelete(remove: () => void) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  function disarm() {
    setArmed(false)
    window.clearTimeout(timer.current)
  }
  function activate() {
    if (armed) {
      disarm()
      void remove()
      return
    }
    setArmed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(disarm, 3000)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { armed, activate, disarm }
}

/** Stable palette pick: hash the FN into the 24-color PALETTE (CONTRACTS §14). */
export function avatarColor(fn: string): string {
  let h = 0
  for (let i = 0; i < fn.length; i++) h = (Math.imul(h, 31) + fn.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length].hex
}

/** First letters of the first two FN words. */
function initials(fn: string): string {
  return fn
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
}

/** ORG components ("Acme;Design") rendered as "Acme, Design". */
export function displayOrg(v: Vcard): string {
  return (v.org ?? '').split(';').filter(Boolean).join(', ')
}

/** Round avatar: photo when present, else initials on the FN's palette color. */
export function ContactAvatar(props: { v: Vcard; size?: number }) {
  const size = props.size ?? 40
  if (props.v.photo) {
    return (
      <img
        src={props.v.photo}
        alt=""
        loading="lazy"
        class="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  const color = avatarColor(props.v.fn)
  return (
    <span
      class="flex shrink-0 items-center justify-center rounded-full font-medium"
      style={{
        width: size,
        height: size,
        backgroundColor: hexToRgba(color, 0.15),
        color,
        fontSize: 'var(--text-sm)',
      }}
      aria-hidden="true"
    >
      {initials(props.v.fn) || '?'}
    </span>
  )
}

/**
 * Chip text for BDAY: `Apr 6, 1980` for full dates, `Apr 6` for the
 * year-less `--MM-DD` form, else the verbatim TEXT value (same shapes the
 * engine's birthday materializer accepts).
 */
function bdayText(bday: string): string {
  const s = bday.trim()
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (full) {
    return new Date(+full[1], +full[2] - 1, +full[3]).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }
  const partial = /^--(\d{2})-(\d{2})/.exec(s)
  if (partial) {
    return new Date(2000, +partial[1] - 1, +partial[2]).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  }
  return s
}

export function ContactDetailPopover(props: {
  record: ContactRecord
  anchor: HTMLElement
  onClose: () => void
  onEdit: () => void
}) {
  const v = props.record.data
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Compute once from the clicked element; clamp to the viewport on all edges.
  const [pos] = useState(() => {
    const rect = props.anchor.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - 16)
    const top = Math.min(Math.max(8, rect.bottom + 6), Math.max(8, window.innerHeight - 320))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    return { top, left, width }
  })

  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    const anchor = props.anchor
    return () => {
      document.removeEventListener('keydown', onKey)
      anchor.focus()
    }
  }, [])

  // Global dialog gate while open (CONTRACTS §16): shortcuts are suppressed.
  useEffect(() => {
    bumpDialogOpen()
    return bumpDialogClose
  }, [])

  const edit = () => {
    props.onClose()
    props.onEdit()
  }

  const [deleting, setDeleting] = useState(false)

  /**
   * Direct delete via the store (same path the detail panel used): the store
   * rolls back + toasts failures itself. No undo payload — the contacts
   * store does not capture one.
   */
  async function remove(): Promise<void> {
    setDeleting(true)
    try {
      await deleteContact(props.record)
      props.onClose()
    } catch {
      // Store toasted; keep the popover open.
    } finally {
      setDeleting(false)
    }
  }

  // Two-step confirm (CONTRACTS §21), same as the event popover: first click
  // arms, second deletes; 3s revert. Any other panel click disarms, and
  // Esc/outside click close the popover, which disarms via unmount cleanup.
  const del = useConfirmDelete(remove)

  return (
    <>
      <div class="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={v.fn || 'Contact details'}
        tabIndex={-1}
        class="card fixed z-50 flex flex-col gap-2 shadow-[var(--shadow-2)] outline-none"
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxWidth: `${WIDTH}px` }}
        onClick={() => {
          if (del.armed) del.disarm()
        }}
      >
        <div class="flex items-start gap-2.5">
          <ContactAvatar v={v} />
          <div class="min-w-0 flex-1">
            <h3 class="break-words text-sm font-semibold text-fg-strong">{v.fn || 'Unnamed'}</h3>
            {(displayOrg(v) !== '' || v.title !== undefined) && (
              <p class="mt-0.5 break-words text-xs text-muted">
                {[displayOrg(v), v.title].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <button type="button" class="btn btn-ghost btn-sm icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon.x size={13} />
          </button>
        </div>

        {v.bday !== undefined && v.bday.trim() !== '' && (
          <p class="flex items-center gap-1.5 text-xs text-fg">
            <span class="rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">
              Birthday · {bdayText(v.bday)}
            </span>
          </p>
        )}

        {v.emails.length > 0 && (
          <div class="flex flex-col gap-1">
            {v.emails.map((e, i) => (
              <div key={i} class="flex items-center gap-1.5 text-xs">
                <Icon.mail size={13} class="shrink-0 text-muted" />
                <a href={`mailto:${e.value}`} class="truncate text-fg hover:underline">
                  {e.value}
                </a>
                {e.types.length > 0 && (
                  <span class="shrink-0 text-[10px] text-muted">{e.types.join(', ')}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {v.tels.length > 0 && (
          <div class="flex flex-col gap-1">
            {v.tels.map((t, i) => (
              <div key={i} class="flex items-center gap-1.5 text-xs">
                <Icon.phone size={13} class="shrink-0 text-muted" />
                <a href={`tel:${t.value.replace(/\s+/g, '')}`} class="truncate text-fg hover:underline">
                  {t.value}
                </a>
                {t.types.length > 0 && (
                  <span class="shrink-0 text-[10px] text-muted">{t.types.join(', ')}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {v.addresses.length > 0 && (
          <div class="flex flex-col gap-1">
            {v.addresses.map((a, i) => (
              <p key={i} class="break-words text-xs text-fg">
                {a.value.split(';').filter(Boolean).join(', ')}
              </p>
            ))}
          </div>
        )}

        {v.note !== undefined && v.note.trim() !== '' && (
          <p class="line-clamp-3 whitespace-pre-line break-words text-xs text-muted">{v.note}</p>
        )}

        <div class="mt-1 flex items-center gap-2">
          <button type="button" class="btn btn-primary btn-sm flex-1" title="Edit contact" onClick={edit}>
            Edit
          </button>
          <button
            type="button"
            class={`btn btn-sm ${del.armed ? 'btn-danger' : 'btn-ghost text-danger'}`}
            title={del.armed ? 'Click again to delete' : 'Delete contact'}
            aria-label={del.armed ? 'Click again to delete' : 'Delete contact'}
            disabled={deleting}
            onClick={del.activate}
          >
            {del.armed ? 'Sure?' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  )
}
