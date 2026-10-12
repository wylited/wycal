/** @jsxImportSource preact */
/**
 * App sidebar (design.md §4, §nav-revamp): search box on top, then per-mode
 * content — Schedule (New event, mini-month, Calendars, saved views, Upcoming,
 * Share availability, accounts), Agenda (Calendars, Events/Todos + todo
 * filter chips, agenda saved views, Upcoming), Contacts (ContactsSidebar) —
 * with mini-month + accounts always present. The six stack sections are
 * separated by draggable separators (prefs.sidebarSectionHeights; double-click
 * resets). Sidebar side flips via prefs.sidebarSide; the old Size control is
 * gone (prefs.sidebarSize stays in storage, no UI writes it).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Fragment } from 'preact';
import type { ComponentChildren } from 'preact';
import { accounts } from '../../stores/accounts';
import {
  collectionColor,
  collections,
  isCalendarVisible,
  toggleCalendar,
} from '../../stores/calendars';
import { prefs, setPrefs } from '../../stores/prefs';
import { allAgendaTags, agendaFilters, clearAgendaTags, setAgendaPriority, setAgendaStatus, toggleAgendaTag } from '../../stores/agendaFilters';
import {
  applyAgendaView,
  applyView,
  deleteAgendaView,
  deleteViewV2,
  keybindConflict,
  renameAgendaView,
  renameViewV2,
  savedAgendaViews,
  savedViewsV2,
  saveCurrentAgendaView,
  saveCurrentView,
  setAgendaViewKeybind,
  setViewKeybind,
} from '../../stores/savedviews';
import { isDialogOpen, isEditableTarget } from '../../stores/ui';
import { push } from '../../stores/toasts';
import { syncState } from '../../lib/sync/engine';
import { addMinutes } from '../../lib/util/date';
import { parseRoutePath, ROUTES, useHash } from '../../routes';
import { Icon } from '../../ui/icons';
import { useFocusTrap } from '../../ui/Modal';
import { openEditor } from '../event-editor/editorState';
import SidebarSearch from '../search/SidebarSearch';
import ContactsSidebar from '../contacts/ContactsSidebar';
import { ShareAvailability } from '../calendar/ShareAvailability';
import { MiniMonth } from './MiniMonth';
import { MiniAgenda } from './MiniAgenda';
import { NewCalendarModal } from './NewCalendarModal';
import { CalSettingsPopover } from './CalSettingsPopover';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Top-level shell modes (§nav-revamp); derived from the hash. */
type ShellMode = 'schedule' | 'agenda' | 'contacts';

/** Resizable sidebar sections (§nav-revamp): stable ids persist heights. */
const SECTION = {
  minmonth: 'sb-minmonth',
  calendars: 'sb-calendars',
  savedviews: 'sb-savedviews',
  upcoming: 'sb-upcoming',
  contacts: 'sb-contacts',
  accounts: 'sb-accounts',
} as const;

/** Separator drag constraints (§nav-revamp): min 60px, max 70% of sidebar. */
const SECTION_MIN_PX = 60;
const SECTION_MAX_FRACTION = 0.7;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof matchMedia === 'undefined' ? true : matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Per-account sync health dots + labels (design.md §5 loading states). */
function AccountStatus() {
  const states = syncState.value;
  if (accounts.value.length === 0) {
    return (
      <div class="flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted">
        <span class="size-2 shrink-0 rounded-full bg-muted" aria-hidden="true" />
        No account connected
      </div>
    );
  }
  return (
    <div class="flex flex-col gap-1 border-t border-border px-4 py-2.5">
      {accounts.value.map((account) => {
        const state = states.get(account.id)?.state ?? 'syncing';
        const detail =
          state === 'ok'
            ? 'Synced'
            : state === 'syncing'
              ? 'Syncing…'
              : (states.get(account.id)?.message ?? 'Sync error');
        return (
          <div
            key={account.id}
            class="flex items-center gap-2 text-xs text-muted"
            title={`${account.username} — ${detail}`}
          >
            <span
              class={`size-2 shrink-0 rounded-full ${state === 'ok' ? 'bg-success' : 'bg-warning'}`}
              aria-hidden="true"
            />
            <span class="min-w-0 truncate">
              <span class="text-fg">{account.username}</span> · {detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Common shape the saved-views section renders (schedule V2 or agenda). */
interface SavedViewRow {
  id: string;
  name: string;
  keybind?: string;
  /** Chip suffix (schedule: visible-calendar count); omitted → none. */
  badge?: string;
  badgeTitle?: string;
  /** Row tooltip. */
  title: string;
}

/**
 * Saved views section (§nav-revamp): shared inline save/rename/keybind UI for
 * both flavors — schedule (V2 composite views) and agenda (prefs-capturing
 * views). Rendered only in its own mode; capture/keybind state is lifted to
 * Sidebar (the document-level handler needs it).
 */
function SavedViewsSection(props: {
  rows: SavedViewRow[];
  emptyText: string;
  captureId: string | null;
  rejectId: string | null;
  onStartCapture: (id: string) => void;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onSave: (name: string) => void;
}) {
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const saveNameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (savingView) saveNameRef.current?.focus();
  }, [savingView]);
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const commitSaveView = (): void => {
    props.onSave(viewName.trim() || 'View');
    setSavingView(false);
    setViewName('');
  };

  const commitRename = (): void => {
    if (renaming) props.onRename(renaming.id, renaming.name);
    setRenaming(null);
  };

  return (
    <nav class="px-2 py-2" aria-label="Saved views">
      <div class="flex items-center justify-between px-2.5 pb-1">
        <span class="text-xs font-medium text-muted">Saved views</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm icon-btn"
          title="Save current view"
          aria-label="Save current view"
          onClick={() => {
            setSavingView(true);
            setViewName('');
          }}
        >
          <Icon.plus size={13} />
        </button>
      </div>
      {savingView && (
        <div class="flex items-center gap-1 pb-1">
          <input
            ref={saveNameRef}
            class="input min-w-0 flex-1"
            value={viewName}
            placeholder="View name"
            aria-label="New saved view name"
            onInput={(e) => setViewName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSaveView();
              else if (e.key === 'Escape') setSavingView(false);
            }}
          />
          <button
            type="button"
            class="btn btn-primary btn-sm icon-btn shrink-0"
            title="Save view"
            aria-label="Save view"
            onClick={commitSaveView}
          >
            <Icon.check size={13} />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm icon-btn shrink-0"
            title="Cancel"
            aria-label="Cancel saving view"
            onClick={() => setSavingView(false)}
          >
            <Icon.x size={13} />
          </button>
        </div>
      )}
      {props.rows.map((v) => (
        <div key={v.id} class="group flex w-full items-center">
          {renaming?.id === v.id ? (
            <input
              ref={renameRef}
              class="input min-w-0 flex-1"
              value={renaming.name}
              placeholder="View name"
              aria-label={`Rename view ${v.name}`}
              onInput={(e) => setRenaming({ id: v.id, name: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              type="button"
              class="chip min-w-0 flex-1"
              title={v.title}
              onClick={() => props.onApply(v.id)}
            >
              <span class="min-w-0 truncate">{v.name}</span>
              {v.badge !== undefined && (
                <span
                  class="shrink-0 rounded-full bg-surface-3 px-1.5 text-[10px] leading-4 text-muted tabular-nums"
                  title={v.badgeTitle}
                >
                  {v.badge}
                </span>
              )}
            </button>
          )}
          {renaming?.id === v.id ? (
            <>
              <button
                type="button"
                class="btn btn-primary btn-sm icon-btn shrink-0"
                title="Rename view"
                aria-label="Confirm rename"
                onClick={commitRename}
              >
                <Icon.check size={13} />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm icon-btn shrink-0"
                title="Cancel rename"
                aria-label="Cancel rename"
                onClick={() => setRenaming(null)}
              >
                <Icon.x size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                class={`shrink-0 rounded border px-1 font-mono text-[10px] leading-4 ${
                  props.rejectId === v.id
                    ? 'border-danger text-danger'
                    : 'border-border bg-surface-2 text-muted'
                } ${
                  v.keybind || props.captureId === v.id
                    ? ''
                    : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                }`}
                title={
                  props.captureId === v.id
                    ? 'Press a key… (Esc cancels)'
                    : v.keybind
                      ? `Keybind ${v.keybind} — click to change`
                      : 'Set keybind'
                }
                aria-label={`Set keybind for ${v.name}`}
                aria-pressed={props.captureId === v.id}
                onClick={() => props.onStartCapture(v.id)}
              >
                {props.captureId === v.id ? '…' : (v.keybind ?? '·')}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm icon-btn shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title="Rename view"
                aria-label={`Rename view ${v.name}`}
                onClick={() => setRenaming({ id: v.id, name: v.name })}
              >
                <Icon.edit size={13} />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm icon-btn shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title="Delete view"
                aria-label={`Delete view ${v.name}`}
                onClick={() => props.onDelete(v.id)}
              >
                <Icon.x size={13} />
              </button>
            </>
          )}
        </div>
      ))}
      {props.rows.length === 0 && (
        <p class="px-2.5 py-1.5 text-sm text-muted">{props.emptyText}</p>
      )}
    </nav>
  );
}

/** Agenda-mode todo filters (§nav-revamp): Events/Todos toggles + status /
 *  priority / tag chips. Values live in prefs (saved views apply them) and
 *  the agendaFilters store; tag chips derive from todos' CATEGORIES. */
function AgendaFilterBlock() {
  const status = agendaFilters.status.value;
  const priority = agendaFilters.priority.value;
  const tags = agendaFilters.tags.value;
  const allTags = allAgendaTags.value;
  return (
    <div class="flex flex-col gap-1.5 border-t border-border px-3 py-2" aria-label="Agenda filters">
      <div class="flex items-center gap-1" role="group" aria-label="Rows shown in agenda">
        <button
          type="button"
          class="sb-chip"
          aria-pressed={prefs.value.agendaEvents ?? true}
          onClick={() => setPrefs({ agendaEvents: !(prefs.value.agendaEvents ?? true) })}
        >
          Events
        </button>
        <button
          type="button"
          class="sb-chip"
          aria-pressed={prefs.value.agendaTodos ?? true}
          onClick={() => setPrefs({ agendaTodos: !(prefs.value.agendaTodos ?? true) })}
        >
          Todos
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Todo status filter">
        {(['all', 'todo', 'doing', 'done'] as const).map((s) => (
          <button
            key={s}
            type="button"
            class="sb-chip capitalize"
            aria-pressed={status === s}
            onClick={() => setAgendaStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Todo priority filter">
        {(['all', 'A', 'B', 'C'] as const).map((p) => (
          <button
            key={p}
            type="button"
            class="sb-chip"
            aria-pressed={priority === p}
            onClick={() => setAgendaPriority(p)}
          >
            {p === 'all' ? 'All' : `#${p}`}
          </button>
        ))}
      </div>
      {allTags.length > 0 && (
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Todo tag filter">
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              class="sb-chip"
              aria-pressed={tags.includes(tag)}
              onClick={() => toggleAgendaTag(tag)}
            >
              {tag}
            </button>
          ))}
          {tags.length > 0 && (
            <button
              type="button"
              class="sb-chip sb-chip-clear"
              title="Clear tag filter"
              aria-label="Clear tag filter"
              onClick={clearAgendaTags}
            >
              <Icon.x size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar(props: { open: boolean; onClose: () => void }) {
  const asideRef = useRef<HTMLElement | null>(null);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const hash = useHash();
  // Focus trap is a drawer affordance: on desktop the sidebar is an inline
  // collapsible column (never modal), so trap only the mobile drawer.
  useFocusTrap(props.open && !isDesktop, asideRef, props.onClose);
  const [newCalOpen, setNewCalOpen] = useState(false);
  const [settings, setSettings] = useState<{ url: string; anchor: HTMLElement } | null>(null);

  // Sidebar side (§nav-revamp): stamp <html data-sidebar-side> for the flip
  // CSS and the §22 resize handle in CalendarView (absent = right).
  useEffect(() => {
    document.documentElement.dataset.sidebarSide = prefs.value.sidebarSide;
  }, [prefs.value.sidebarSide]);

  const { path, query } = parseRoutePath(hash.replace(/^#/, ''));
  const mode: ShellMode =
    path === ROUTES.contacts
      ? 'contacts'
      : path === ROUTES.calendar && query.get('view') === 'agenda'
        ? 'agenda'
        : 'schedule';

  const dateParam = query.get('date');
  const routeDate = dateParam && DATE_KEY.test(dateParam) ? dateParam : null;

  // --- Section heights (§nav-revamp): drag a separator to resize the LOWER
  // adjacent section (flex-basis px, 60px…70% of sidebar); double-click
  // resets both neighbors to auto. Persisted debounced 300ms.
  const [heights, setHeights] = useState<Record<string, number>>(() => ({
    ...(prefs.value.sidebarSectionHeights ?? {}),
  }));
  const heightsRef = useRef(heights);
  const heightsTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ lower: string; startY: number; startLower: number; max: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  function applyHeights(next: Record<string, number>, immediate = false): void {
    heightsRef.current = next;
    setHeights(next);
    window.clearTimeout(heightsTimer.current);
    heightsTimer.current = window.setTimeout(
      () => setPrefs({ sidebarSectionHeights: heightsRef.current }),
      immediate ? 0 : 300,
    );
  }

  function onSepPointerDown(e: PointerEvent, lowerId: string): void {
    const aside = asideRef.current;
    const lowerEl = aside?.querySelector<HTMLElement>(`[data-section="${lowerId}"]`);
    if (!aside || !lowerEl) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      lower: lowerId,
      startY: e.clientY,
      startLower: lowerEl.getBoundingClientRect().height,
      max: aside.clientHeight * SECTION_MAX_FRACTION,
    };
    setDragging(lowerId);
  }

  function onSepPointerMove(e: PointerEvent): void {
    const d = drag.current;
    if (!d) return;
    const next = Math.min(d.max, Math.max(SECTION_MIN_PX, d.startLower - (e.clientY - d.startY)));
    applyHeights({ ...heightsRef.current, [d.lower]: Math.round(next) });
  }

  function onSepPointerEnd(e: PointerEvent): void {
    if (!drag.current) return;
    drag.current = null;
    setDragging(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function onSepDoubleClick(upperId: string, lowerId: string): void {
    const next = { ...heightsRef.current };
    delete next[upperId];
    delete next[lowerId];
    applyHeights(next, true);
  }

  useEffect(() => () => window.clearTimeout(heightsTimer.current), []);

  // Saved-view keybinds (V2 + agenda): document-level dispatch, gated like the
  // §16 handlers (inputs/dialogs); scoped to the active mode's list. While a
  // row is capturing, the next safe key is bound; stopImmediatePropagation
  // swallows it before the app.tsx and useShortcuts handlers (registered
  // later — child effects run first).
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const captureRef = useRef<string | null>(null);
  captureRef.current = captureId;
  const modeRef = useRef<ShellMode>(mode);
  modeRef.current = mode;
  const rejectTimer = useRef<number | undefined>(undefined);

  // Close the drawer on any navigation (mobile only — the desktop column is
  // not dismissible by navigation).
  useEffect(() => {
    if (props.open && !isDesktop) props.onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  useEffect(() => {
    const el = asideRef.current;
    // Hidden both as a mobile drawer and as a collapsed desktop column:
    // inert keeps the clipped desktop content out of the tab order.
    if (el) el.inert = !props.open;
    // Hoisted-out popover: drop it when its anchor drawer closes on mobile
    // (pre-hoist it lived inside the aside going inert).
    if (!isDesktop && !props.open) setSettings(null);
  }, [isDesktop, props.open]);

  // Global keybind (useShortcuts): Shift+C opens the new-calendar dialog.
  // The event fires twice by design — setting the same state twice is fine.
  useEffect(() => {
    const openNewCalendar = (): void => setNewCalOpen(true);
    window.addEventListener('wycal:newcalendar', openNewCalendar);
    return () => window.removeEventListener('wycal:newcalendar', openNewCalendar);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const capturing = captureRef.current;
      if (capturing !== null) {
        if (isEditableTarget(e.target) || isDialogOpen()) return;
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') {
          setCaptureId(null);
          return;
        }
        if (keybindConflict(e.key, capturing)) {
          setRejectId(capturing);
          window.clearTimeout(rejectTimer.current);
          rejectTimer.current = window.setTimeout(() => setRejectId(null), 1500);
          return;
        }
        if (savedViewsV2.value.some((v) => v.id === capturing)) setViewKeybind(capturing, e.key);
        else setAgendaViewKeybind(capturing, e.key);
        setCaptureId(null);
        return;
      }
      if (isEditableTarget(e.target) || isDialogOpen()) return;
      const key = e.key;
      if (modeRef.current === 'agenda') {
        const view = savedAgendaViews.value.find((v) => v.keybind === key);
        if (view) {
          e.preventDefault();
          applyAgendaView(view.id);
        }
        return;
      }
      const view = savedViewsV2.value.find((v) => v.keybind === key);
      if (!view) return;
      e.preventDefault();
      applyView(view.id);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(rejectTimer.current);
    };
  }, []);

  const calendars = collections.value.filter((c) => c.kind === 'calendar');
  const anySyncing = [...syncState.value.values()].some((s) => s.state === 'syncing');

  const onNew = (): void => {
    props.onClose();
    const start = new Date();
    start.setSeconds(0, 0);
    const bump = 30 - (start.getMinutes() % 30) || 30; // strictly next half-hour
    start.setMinutes(start.getMinutes() + bump);
    const end = addMinutes(start, prefs.value.defaultDurationMin);
    openEditor({
      mode: 'create',
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      allDay: false,
    });
  };

  const [shareOpen, setShareOpen] = useState(false);

  // --- Section stack (§nav-revamp): order is mode-dependent; mini-month and
  // accounts are always present.
  const sections: Array<{ id: string; label: string; node: ComponentChildren }> = [];
  sections.push({
    id: SECTION.minmonth,
    label: 'Mini-month',
    node: (
      <div class="px-3 pb-2 pt-2">
        <MiniMonth routeDate={routeDate} />
      </div>
    ),
  });
  sections.push({
    id: SECTION.calendars,
    label: 'Calendars',
    node: (
      <nav class="min-h-0 px-2 pb-2" aria-label="Calendars">
        <div class="px-2.5 pt-1 pb-1 text-xs font-medium text-muted">Calendars</div>
        {calendars.length === 0 ? (
          anySyncing ? (
            <div role="status">
              <span class="sr-only">Loading calendars…</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} class="flex items-center gap-2 px-2.5 py-1.5" aria-hidden="true">
                  <span class="size-2 animate-pulse rounded-full bg-surface-2" />
                  <span
                    class="h-3 flex-1 animate-pulse rounded-full bg-surface-2"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p class="px-2.5 py-1.5 text-sm text-muted">No calendars</p>
          )
        ) : (
          calendars.map((cal, i) => (
            <div key={cal.url} class="flex w-full items-center">
              <label class="chip min-w-0 flex-1" title={cal.url}>
                <input
                  type="checkbox"
                  class="size-3.5 shrink-0 accent-accent"
                  checked={isCalendarVisible(cal.url)}
                  onChange={() => toggleCalendar(cal.url)}
                  aria-label={`Show ${cal.name}`}
                  title={`Show ${cal.name} (${i + 1})`}
                />
                <span
                  class="chip-dot"
                  style={{ '--chip-color': collectionColor(cal) }}
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate">{cal.name}</span>
              </label>
              {cal.components.includes('VTODO') && (
                <span
                  class="shrink-0 p-1 text-muted"
                  title="Supports tasks"
                  role="img"
                  aria-label="Supports tasks"
                >
                  <Icon.check size={12} />
                </span>
              )}
              <button
                type="button"
                class="btn btn-ghost btn-sm icon-btn shrink-0"
                title={`${cal.name} settings`}
                aria-label={`${cal.name} settings`}
                aria-haspopup="dialog"
                onClick={(e) => setSettings({ url: cal.url, anchor: e.currentTarget })}
              >
                <Icon.settings size={13} />
              </button>
            </div>
          ))
        )}
        <button
          type="button"
          class="btn btn-ghost btn-sm mt-1 w-full text-muted"
          title="New calendar (Shift+C)"
          onClick={() => setNewCalOpen(true)}
        >
          <Icon.plus size={13} />
          New calendar
        </button>
      </nav>
    ),
  });
  if (mode !== 'contacts') {
    const scheduleRows: SavedViewRow[] =
      mode === 'schedule'
        ? savedViewsV2.value.map((v) => ({
            id: v.id,
            name: v.name,
            keybind: v.keybind,
            badge: v.visibility.length === 0 ? 'all' : String(v.visibility.length),
            badgeTitle:
              v.visibility.length === 0
                ? 'All calendars visible'
                : `${v.visibility.length} ${
                    v.visibility.length === 1 ? 'calendar' : 'calendars'
                  } visible`,
            title:
              v.visibility.length === 0
                ? `${v.name} — apply (all calendars, ${v.view})`
                : `${v.name} — apply (${v.visibility.length} ${
                    v.visibility.length === 1 ? 'calendar' : 'calendars'
                  }, ${v.view})`,
          }))
        : savedAgendaViews.value.map((v) => ({
            id: v.id,
            name: v.name,
            keybind: v.keybind,
            title: `${v.name} — apply (${v.group === 'day' ? 'day groups' : 'by calendar'}, ${
              [v.events ? 'events' : null, v.todos ? 'todos' : null].filter(Boolean).join(' + ') ||
              'nothing'
            }${v.statusFilter && v.statusFilter !== 'all' ? `, ${v.statusFilter}` : ''}${
              v.priorityFilter && v.priorityFilter !== 'all' ? `, #${v.priorityFilter}` : ''
            })`,
          }));
    sections.push({
      id: SECTION.savedviews,
      label: 'Saved views',
      node: (
        <SavedViewsSection
          rows={scheduleRows}
          emptyText={
            mode === 'schedule'
              ? 'No saved views — save one with + above'
              : 'No agenda views — save one with + above'
          }
          captureId={captureId}
          rejectId={rejectId}
          onStartCapture={(id) => {
            setRejectId(null);
            setCaptureId((cur) => (cur === id ? null : id));
          }}
          onApply={(id) => {
            if (mode === 'agenda') applyAgendaView(id);
            else applyView(id);
          }}
          onRename={(id, name) => {
            if (mode === 'agenda') renameAgendaView(id, name);
            else renameViewV2(id, name);
          }}
          onDelete={(id) => {
            if (mode === 'agenda') deleteAgendaView(id);
            else deleteViewV2(id);
          }}
          onSave={(name) => {
            if (mode === 'agenda') {
              const saved = saveCurrentAgendaView(name === 'View' ? undefined : name);
              push('success', `Agenda view "${saved.name}" saved`);
            } else {
              const saved = saveCurrentView(name === 'View' ? undefined : name);
              push('success', `View "${saved.name}" saved`);
            }
          }}
        />
      ),
    });
    sections.push({
      id: SECTION.upcoming,
      label: 'Upcoming',
      node: <MiniAgenda />,
    });
  } else {
    sections.push({
      id: SECTION.contacts,
      label: 'Contacts',
      node: <ContactsSidebar />,
    });
  }
  sections.push({
    id: SECTION.accounts,
    label: 'Accounts',
    node: <AccountStatus />,
  });

  const side = prefs.value.sidebarSide;

  return (
    <>
      <div
        class={`fixed inset-0 z-30 bg-overlay transition-opacity duration-200 ease-out md:hidden ${
          props.open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={props.onClose}
        aria-hidden="true"
      />
      {/* Desktop (≥768px): an inline column that X collapses to zero width —
          overflow-hidden + the fixed min-w inner wrapper clip the content
          during the width transition. Mobile: off-canvas drawer, unchanged.
          §nav-revamp: the column hugs the window edge prefs.sidebarSide —
          flex `order` puts it after the main column by default (right). */}
      <aside
        ref={asideRef}
        aria-label="Calendar sidebar"
        class={`app-sidebar fixed inset-y-0 z-40 flex w-(--drawer-w) shrink-0 flex-col overflow-hidden bg-surface transition-[transform,width] duration-200 ease-out md:static md:translate-x-0 ${
          side === 'left' ? 'left-0 border-r border-border' : 'right-0 border-l border-border'
        } ${
          props.open
            ? 'translate-x-0 shadow-[var(--shadow-2)] md:w-(--sidebar-w)'
            : side === 'left'
              ? '-translate-x-full md:w-0 md:border-r-0'
              : 'translate-x-full md:w-0 md:border-l-0'
        }`}
        style={{ order: side === 'left' ? 1 : 3 }}
      >
        <div class="app-sidebar-body flex min-h-0 min-w-(--sidebar-w) flex-1 flex-col">
          {/* Search (§nav-revamp): every mode; '/' / ⌘K focus it. */}
          <SidebarSearch onNavigate={props.onClose} />
          {mode === 'schedule' && (
            <div class="flex flex-col gap-1.5 px-4 pb-2">
              <button type="button" class="btn btn-primary w-full" title="New event (N)" onClick={onNew}>
                <Icon.plus size={14} />
                New event
              </button>
            </div>
          )}
          {mode === 'agenda' && <AgendaFilterBlock />}
          {/* Resizable section stack with drag separators. */}
          <div class="sb-sections flex min-h-0 flex-1 flex-col">
            {sections.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 && (
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize ${s.label} section (double-click to reset)`}
                    class={`sb-sep ${dragging === s.id ? 'is-dragging' : ''}`}
                    onPointerDown={(e) => onSepPointerDown(e, s.id)}
                    onPointerMove={onSepPointerMove}
                    onPointerUp={onSepPointerEnd}
                    onPointerCancel={onSepPointerEnd}
                    onDblClick={() => onSepDoubleClick(sections[i - 1].id, s.id)}
                  />
                )}
                <section
                  class="sb-section"
                  data-section={s.id}
                  aria-label={s.label}
                  style={heights[s.id] !== undefined ? { flex: `0 0 ${heights[s.id]}px` } : undefined}
                >
                  <div class="sb-section-body">
                    {s.node}
                  </div>
                </section>
              </Fragment>
            ))}
          </div>
          {mode === 'schedule' && (
            <div class="flex items-center justify-center border-t border-border px-4 py-1.5">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                title="Copy free/busy slots for the next week"
                onClick={() => setShareOpen(true)}
              >
                Share availability
              </button>
            </div>
          )}
        </div>
      </aside>
      {/* Fixed-position overlays live outside <aside>: on mobile the aside
          goes inert when closed, which would break their focus. */}
      {settings !== null && (
        <CalSettingsPopover calUrl={settings.url} anchor={settings.anchor} onClose={() => setSettings(null)} />
      )}
      <NewCalendarModal open={newCalOpen} onClose={() => setNewCalOpen(false)} />
      <ShareAvailability open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );
}
