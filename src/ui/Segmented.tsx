/** @jsxImportSource preact */
/**
 * Segmented control (design.md §5): --surface-2 track, active segment lifts to
 * --surface with --shadow-1 and --fg-strong (via app.css `.segmented` +
 * `.is-active`). Uses role=tablist semantics with roving tabindex and
 * Arrow/Home/End keyboard selection.
 */
import { useRef } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

export interface SegmentedOption<T> {
  value: T;
  label: ComponentChildren;
  title?: string;
}

interface SegmentedProps<T> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name for the group (no visible label is rendered). */
  ariaLabel?: string;
  class?: string;
}

export function Segmented<T>(props: SegmentedProps<T>) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.value),
  );

  const select = (index: number): void => {
    const option = props.options[index];
    if (option !== undefined && option.value !== props.value) props.onChange(option.value);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    const max = props.options.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = activeIndex === max ? 0 : activeIndex + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = activeIndex === 0 ? max : activeIndex - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    select(next);
    buttonsRef.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={props.ariaLabel} class={`segmented${props.class ? ` ${props.class}` : ''}`} onKeyDown={onKeyDown}>
      {props.options.map((option, i) => (
        <button
          key={i}
          ref={(el) => {
            buttonsRef.current[i] = el;
          }}
          type="button"
          role="tab"
          title={option.title}
          aria-selected={i === activeIndex}
          tabIndex={i === activeIndex ? 0 : -1}
          class={i === activeIndex ? 'is-active' : undefined}
          onClick={() => {
            select(i);
            buttonsRef.current[i]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
