/** @jsxImportSource preact */
/**
 * Scratch-notes panel (design.md §9.8): a slide-up buffer for quick thoughts,
 * toggled by the global `\` keybind. Desktop: fixed bottom-left 420px card,
 * max-height 60vh; mobile (<768px): full-width bottom sheet. The header has
 * the 'Scratch' title, a 'Saved' indicator that pulses on persist (no
 * spinner — saves are debounced), a 2-step clear, and a close ×. Esc closes.
 * While open it registers bumpDialogOpen so the §16 keybinds stay gated.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from '../../ui/icons';
import { bumpDialogClose, bumpDialogOpen, dialogCount } from '../../stores/ui';
import {
  lastSavedAt,
  notesOpen,
  notesText,
  setNotesText,
} from '../../stores/notes';
import {
  contacts,
  requestOpenContact,
} from '@wycal/core/stores/contacts';
import type { ContactRecord } from '@wycal/core/stores/contacts';
import { ROUTES } from '../../routes';

/** How long the 'Saved' indicator pulses after a persist (ms). */
const SAVED_FLASH_MS = 1500;
/** How long before the 2-step clear reverts from 'Sure?' to 'Clear' (ms). */
const CLEAR_CONFIRM_MS = 3000;
/** Max contact suggestions in the @mention popup. */
const MENTION_MAX = 7;
/** '@' query longer than this closes the popup (stray @, not a name). */
const MENTION_QUERY_LIMIT = 64;

/**
 * Contacts matching the current '@' query (FN `contains`, case-insensitive),
 * alphabetical, capped at MENTION_MAX.
 */
function mentionCandidates(query: string): ContactRecord[] {
  const q = query.toLowerCase();
  return [...contacts.value.values()]
    .filter((r) => r.data.fn.toLowerCase().includes(q))
    .sort((a, b) => a.data.fn.localeCompare(b.data.fn))
    .slice(0, MENTION_MAX);
}

/** One rendered run of the notes preview: plain text or a resolved mention. */
type MentionSegment =
  | { kind: 'text'; value: string }
  | { kind: 'mention'; value: string; href: string };

/**
 * Split note text into runs, resolving `@Full Name` spans against contacts.
 * Longest FN wins at each '@' (so '@Carol Lee' never matches '@Carol'); the
 * typed casing is kept as the chip label; unresolved '@' stays plain text.
 * Notes persist as plain text — this pass is render-time only.
 */
function mentionSegments(text: string): MentionSegment[] {
  const byName = [...contacts.value.values()]
    .map((r) => ({ href: r.href, fn: r.data.fn }))
    .filter((r) => r.fn !== '' && !r.fn.includes('@'))
    .sort((a, b) => b.fn.length - a.fn.length);
  const out: MentionSegment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@') {
      const rest = text.slice(i + 1).toLowerCase();
      const hit = byName.find((c) => rest.startsWith(c.fn.toLowerCase()));
      if (hit !== undefined) {
        out.push({ kind: 'mention', value: text.slice(i + 1, i + 1 + hit.fn.length), href: hit.href });
        i += 1 + hit.fn.length;
        continue;
      }
    }
    const nextAt = text.indexOf('@', i + 1);
    const end = nextAt < 0 ? text.length : nextAt;
    out.push({ kind: 'text', value: text.slice(i, end) });
    i = end;
  }
  return out;
}

/** Scratch-notes panel; renders nothing while closed. */
export function ScratchNotes(): ComponentChildren {
  if (!notesOpen.value) return null;
  return <NotesPanel />;
}

function NotesPanel(): ComponentChildren {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const savedAt = lastSavedAt.value;
  const prevSavedAt = useRef(savedAt);
  const [flash, setFlash] = useState(false);
  /** Open @mention autocomplete: '@' offset in the text, typed query, highlighted row. */
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);

  // Dialog gating: while open the panel counts as a dialog so the global
  // keybinds (CONTRACTS §16) stay gated; cleanup pairs on close/unmount.
  useEffect(() => {
    bumpDialogOpen();
    return () => bumpDialogClose();
  }, []);

  // Esc closes — but only when the panel is the topmost surface; another
  // open dialog keeps Escape for its own focus trap (design.md §7).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (dialogCount.value > 1) return;
      notesOpen.value = false;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Autofocus with the caret at the end so typing starts immediately.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Pulse 'Saved' whenever a persist lands (skip the value restored on open).
  useEffect(() => {
    if (savedAt === prevSavedAt.current) return;
    prevSavedAt.current = savedAt;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), SAVED_FLASH_MS);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Revert the 2-step clear after 3s of inaction.
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmClear]);

  // --- @contact mentions (render-time resolution; notes stay plain text) ---

  /** Re-derive the popup from the caret: '@' preceded by whitespace/opening opens it. */
  function refreshMention(): void {
    const el = textareaRef.current;
    if (el === null) {
      setMention(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    const before = el.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    const query = before.slice(at + 1);
    if (
      at < 0 ||
      (at > 0 && !/\s/.test(before[at - 1])) ||
      query.length > MENTION_QUERY_LIMIT ||
      query.includes('\n')
    ) {
      setMention(null);
      return;
    }
    setMention({ start: at, query, active: 0 });
  }

  /** Replace the '@query' token with '@Full Name ' and park the caret after it. */
  function insertMention(rec: ContactRecord): void {
    const el = textareaRef.current;
    if (el === null || mention === null) return;
    const caret = el.selectionStart ?? el.value.length;
    const inserted = `@${rec.data.fn} `;
    const next = el.value.slice(0, mention.start) + inserted + el.value.slice(caret);
    const pos = mention.start + inserted.length;
    setNotesText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  /**
   * Popup keybinds: ↑↓ move the highlight (wrapping), Enter/Tab insert,
   * Esc dismisses the popup only — propagation stopped so the panel-level
   * document Esc handler never closes Scratch while a popup is up.
   */
  function onMentionKeyDown(e: KeyboardEvent): void {
    if (mention === null) return;
    const matches = mentionCandidates(mention.query);
    if (matches.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setMention({ ...mention, active: (mention.active + delta + matches.length) % matches.length });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      insertMention(matches[Math.min(mention.active, matches.length - 1)]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMention(null);
    }
  }

  /** Mention chip click → open the contact in the main contacts view. */
  function openMention(href: string): void {
    // The detail popover lives in ContactsView; on other routes navigate there
    // first — the pending request is consumed when the view mounts.
    if (window.location.hash !== `#${ROUTES.contacts}`) window.location.hash = `#${ROUTES.contacts}`;
    requestOpenContact(href);
  }

  const onClear = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setNotesText('');
    setMention(null);
    textareaRef.current?.focus();
  };

  const segments = mentionSegments(notesText.value);
  const hasMentions = segments.some((s) => s.kind === 'mention');
  const suggestions = mention !== null ? mentionCandidates(mention.query) : [];
  const activeIdx = Math.min(mention?.active ?? 0, Math.max(suggestions.length - 1, 0));

  return (
    <section
      aria-label="Scratch notes"
      class="fixed bottom-4 left-4 z-40 flex max-h-[60vh] w-[420px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-2)] max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[70dvh] max-md:w-full max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0"
    >
      <header class="flex items-center gap-2 border-b border-border px-3 py-2">
        <span class="text-sm font-semibold text-fg-strong">Scratch</span>
        {lastSavedAt.value > 0 && (
          <span
            role="status"
            class={`text-xs tabular-nums ${flash ? 'animate-pulse text-accent' : 'text-muted'}`}
          >
            Saved
          </span>
        )}
        <span class="min-w-0 flex-1" />
        <button
          type="button"
          onClick={onClear}
          class={`rounded-sm px-2 py-0.5 text-xs transition-colors hover:bg-surface-2 ${
            confirmClear ? 'bg-danger-soft text-danger' : 'text-muted'
          }`}
        >
          {confirmClear ? 'Sure?' : 'Clear'}
        </button>
        <button
          type="button"
          aria-label="Close scratch notes"
          onClick={() => (notesOpen.value = false)}
          class="rounded-sm p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
        >
          <Icon.x size={14} />
        </button>
      </header>
      <div class="relative flex min-h-0 flex-1 flex-col">
        {mention !== null && suggestions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Contact suggestions"
            class="absolute left-2 top-2 z-10 max-h-44 w-64 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-[var(--shadow-2)]"
          >
            {suggestions.map((rec, i) => (
              <li key={rec.href} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  class={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors ${
                    i === activeIdx ? 'bg-surface-2 text-fg-strong' : 'text-fg hover:bg-surface-2'
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertMention(rec)}
                  onMouseEnter={() => {
                    if (mention !== null) setMention({ ...mention, active: i });
                  }}
                >
                  <Icon.users size={13} class="shrink-0 text-muted" />
                  <span class="truncate">{rec.data.fn || 'Unnamed'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          value={notesText.value}
          onInput={(e) => {
            setNotesText(e.currentTarget.value);
            refreshMention();
          }}
          onSelect={refreshMention}
          onKeyDown={onMentionKeyDown}
          placeholder="Type anything… (@ to mention a contact)"
          spellcheck={false}
          class="h-48 min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-muted"
        />
      </div>
      {hasMentions && (
        <div
          aria-label="Note mentions"
          class="max-h-32 overflow-y-auto border-t border-border px-3 py-2 text-sm leading-relaxed text-fg"
        >
          {segments.map((seg, i) =>
            seg.kind === 'text' ? (
              <span key={i} class="whitespace-pre-wrap">
                {seg.value}
              </span>
            ) : (
              <button
                key={i}
                type="button"
                class="tag-chip"
                title="Open contact"
                onClick={() => openMention(seg.href)}
              >
                @{seg.value}
              </button>
            ),
          )}
        </div>
      )}
    </section>
  );
}
