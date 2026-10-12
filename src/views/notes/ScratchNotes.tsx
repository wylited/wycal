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

/** How long the 'Saved' indicator pulses after a persist (ms). */
const SAVED_FLASH_MS = 1500;
/** How long before the 2-step clear reverts from 'Sure?' to 'Clear' (ms). */
const CLEAR_CONFIRM_MS = 3000;

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

  const onClear = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setNotesText('');
    textareaRef.current?.focus();
  };

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
      <textarea
        ref={textareaRef}
        value={notesText.value}
        onInput={(e) => setNotesText(e.currentTarget.value)}
        placeholder="Type anything…"
        spellcheck={false}
        class="h-48 min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-muted"
      />
    </section>
  );
}
