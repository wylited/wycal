/**
 * Agenda-mode todo filters (§nav-revamp): the sidebar's agenda filter chips.
 *
 * status/priority are the persisted prefs (agenda saved views apply them), so
 * they are exposed as computed signals reading `prefs` — `.value` works like
 * any signal and updates live when the sidebar (or a saved view) writes them.
 * tags is the selected CATEGORIES filter, session-local by design (not part
 * of saved views), plus `allAgendaTags` derived from the todos store for the
 * chip row.
 */
import { computed, signal } from '@preact/signals'
import { prefs, setPrefs } from './prefs'
import type { AgendaPriorityFilter, AgendaStatusFilter } from './prefs'
import { todos } from './todos'

export interface AgendaFilters {
  status: AgendaStatusFilter
  priority: AgendaPriorityFilter
  tags: string[]
}

/** Agenda todo STATUS filter — persisted (prefs.agendaStatusFilter). */
export const agendaFilters = {
  status: computed<AgendaStatusFilter>(() => prefs.value.agendaStatusFilter ?? 'all'),
  priority: computed<AgendaPriorityFilter>(() => prefs.value.agendaPriorityFilter ?? 'all'),
  tags: signal<string[]>([]),
} as const;

/** Write the status chip (sidebar ↔ prefs ↔ agenda saved views). */
export function setAgendaStatus(status: AgendaStatusFilter): void {
  setPrefs({ agendaStatusFilter: status });
}

/** Write the priority chip. */
export function setAgendaPriority(priority: AgendaPriorityFilter): void {
  setPrefs({ agendaPriorityFilter: priority });
}

/** Toggle one tag in the selected-tags filter. */
export function toggleAgendaTag(tag: string): void {
  const cur = agendaFilters.tags.value;
  agendaFilters.tags.value = cur.includes(tag)
    ? cur.filter((t) => t !== tag)
    : [...cur, tag];
}

/** Clear the selected-tags filter (the tags chip row's reset affordance). */
export function clearAgendaTags(): void {
  agendaFilters.tags.value = [];
}

/** Union of every todo's CATEGORIES, alphabetical — the tag chip row. */
export const allAgendaTags = computed<string[]>(() => {
  const tags = new Set<string>();
  for (const rec of todos.value.values()) {
    for (const tag of rec.data.categories ?? []) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
});
