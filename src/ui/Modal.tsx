/** @jsxImportSource preact */
/**
 * Shared modal (design.md §5): centered 480px card (--r-lg, --surface,
 * --shadow-2) over an --overlay scrim; mobile (<768px) becomes a full-width
 * bottom sheet. 200ms fade + scale(.98→1) entrance, Esc closes, focus is
 * trapped inside and restored on close (design.md §6–§7).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { Icon } from './icons';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab focus inside `containerRef` while `active`, close on Escape, and
 * restore focus to the previously-focused element on close. Shared by Modal
 * and the shell's mobile drawer.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (focusables()[0] ?? container)?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || !container?.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !container?.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
    // Captured on activation; consumers pass stable close callbacks
    // (state setters), so re-running on identity churn would reset focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: number;
}

/** Centered dialog card; renders nothing when closed. */
export function Modal(props: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);
  useFocusTrap(props.open, panelRef, props.onClose);

  useEffect(() => {
    if (!props.open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [props.open]);

  if (!props.open) return null;

  const style =
    props.width !== undefined
      ? { width: `${props.width}px`, maxWidth: 'calc(100vw - 2rem)' }
      : undefined;

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 max-md:items-end max-md:p-0">
      <div
        class={`absolute inset-0 bg-overlay transition-opacity duration-200 ease-out ${
          shown ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={props.onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        style={style}
        class={`relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-surface shadow-[var(--shadow-2)] transition-[opacity,transform] duration-200 ease-out max-md:max-h-[92dvh] max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)] ${
          props.width !== undefined ? '' : 'max-w-120'
        } ${shown ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0'}`}
      >
        <div class="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
          <h2 class="text-md font-semibold text-fg-strong">{props.title}</h2>
          <button
            type="button"
            class="btn btn-ghost btn-sm icon-btn"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            <Icon.x size={14} />
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div class="flex flex-col gap-2">{props.children}</div>
        </div>
        {props.footer !== undefined && (
          <div class="flex justify-end gap-2 px-5 pb-5">{props.footer}</div>
        )}
      </div>
    </div>
  );
}
