/** @jsxImportSource preact */
/**
 * Keyboard-shortcut help overlay (CONTRACTS §16, design.md §9.5): a standard
 * Modal titled 'Keyboard shortcuts' with two columns of grouped `.help-table`
 * tables (Global / Calendar / Tasks / Dialogs) covering the full §16 table.
 * Opens from the `?` key or the header `?` button; Q/Esc close via the shared
 * modal focus trap. `<kbd>` is styled globally (app.css).
 */
import type { ComponentChildren } from 'preact';
import { Modal } from './Modal';
import { helpOpen } from '../stores/ui';

/** One shortcut row: [action label, key tokens]. */
type Shortcut = [action: string, keys: string[]];

const GLOBAL: Shortcut[] = [
  ['New event', ['N']],
  ['New task', ['Shift', 'N']],
  ['New contact', ['C']],
  ['New calendar', ['Shift', 'C']],
  ['Search', ['/']],
  ['Settings', ['S']],
  ['Toggle sidebar', ['X']],
  ['Scratch notes', ['\\']],
  ['Help', ['?']],
  ['Show/hide calendar 1–9', ['1', '9']],
  ['Close dialog', ['Q', 'Esc']],
];

const CALENDAR: Shortcut[] = [
  ['Day view', ['D']],
  ['Week view', ['W']],
  ['2-week view', ['Shift', 'W']],
  ['Month view', ['M']],
  ['Agenda view', ['A']],
  ['Tasks', ['T']],
  ['Today', ['.', 't']],
  ['Previous / next period', ['←', '→']],
  ['Previous period', [',']],
  ['Step N-days', ['+', '-']],
  ['Event details (selected)', ['E']],
  ['Delete selected event', ['⌫', '⌦']],
  ['Undo (toast action)', ['Z']],
];

const TASKS: Shortcut[] = [
  ['New task (quick-add)', ['Shift', 'N']],
  ['Quick-add create', ['Enter']],
];

const DIALOGS: Shortcut[] = [
  ['Cancel / close', ['Esc']],
  ['Save', ['⌘/Ctrl', 'Enter']],
  ['Delete', ['⌘/Ctrl', 'Shift', '⌫']],
];

function ShortcutGroup(props: { title: string; items: Shortcut[] }): ComponentChildren {
  return (
    <section class="min-w-0">
      <h3 class="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        {props.title}
      </h3>
      <table class="help-table w-full">
        <tbody>
          {props.items.map(([action, keys]) => (
            <tr key={action}>
              <td class="whitespace-nowrap">
                {keys.map((key, i) => (
                  <span key={key}>
                    {i > 0 && <span class="mr-1 text-muted">+</span>}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </td>
              <td class="text-fg">{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Help overlay for the `?` affordance; renders nothing while closed. */
export function HelpOverlay(): ComponentChildren {
  return (
    <Modal
      open={helpOpen.value}
      title="Keyboard shortcuts"
      width={620}
      onClose={() => (helpOpen.value = false)}
    >
      <div class="grid gap-6 sm:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-5">
          <ShortcutGroup title="Global" items={GLOBAL} />
          <ShortcutGroup title="Dialogs" items={DIALOGS} />
        </div>
        <div class="flex min-w-0 flex-col gap-5">
          <ShortcutGroup title="Calendar" items={CALENDAR} />
          <ShortcutGroup title="Tasks" items={TASKS} />
        </div>
      </div>
    </Modal>
  );
}
