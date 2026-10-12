/**
 * Todo editor open/close state (CONTRACTS §14a), mirroring the event
 * editor's editorState.ts pattern: §9.4 row entry points (pencil icon-btn,
 * title double-click, `E` keybind) call `openTodoEditor()` and TasksView
 * mounts a single editor modal rendering from the `todoEditor` signal.
 * Esc/scrim/Cancel discard via `closeTodoEditor()`.
 */
import { signal } from '@preact/signals'
import type { TodoRecord } from '../../stores/todos'

/** The record being edited, or null when the editor is closed. */
export const todoEditor = signal<TodoRecord | null>(null)

/** Open the todo editor for `record` (replaces any open editor). */
export function openTodoEditor(record: TodoRecord): void {
  todoEditor.value = record
}

/** Close the todo editor, discarding any unsaved changes. */
export function closeTodoEditor(): void {
  todoEditor.value = null
}
