/** @jsxImportSource preact */
/**
 * App sidebar (design.md §4): New event button (CONTRACTS §18), mini-month
 * (./MiniMonth), calendar list with color dots + visibility checkboxes +
 * VTODO check mark and per-calendar settings popover, mini agenda
 * (./MiniAgenda), saved views — V2 calendar-context views (visibility + view
 * + single-key keybind) above the §15 V1 composites — and the account status
 * row.
 *
 * <768px it becomes an off-canvas drawer: scrim, hamburger-driven (Header),
 * Esc to close, focus trapped, focus restored on close, `inert` when hidden.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { accounts } from '../../stores/accounts';
import {
  collectionColor,
  collections,
  isCalendarVisible,
  toggleCalendar,
} from '../../stores/calendars';
import { prefs, setPrefs } from '../../stores/prefs';
import type { SidebarSize } from '../../stores/prefs';
import {
  applyView,
  deleteView,
  deleteViewV2,
  keybindConflict,
  renameViewV2,
  savedViews,
  savedViewsV2,
  saveCurrentView,
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
import { MiniMonth } from './MiniMonth';
import { MiniAgenda } from './MiniAgenda';
import { NewCalendarModal } from './NewCalendarModal';
import { CalSettingsPopover } from './CalSettingsPopover';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Sidebar sizing presets, smallest → largest (prefs.sidebarSize). */
const SIDEBAR_SIZES: readonly SidebarSize[] = ['compact', 'default', 'large'];

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

export function Sidebar(props: { open: boolean; onClose: () => void }) {
  const asideRef = useRef<HTMLElement | null>(null);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const hash = useHash();
  // Tasks footer link mirrors the header icon buttons' aria-current pattern.
  const onTasks = parseRoutePath(hash.replace(/^#/, '')).path === ROUTES.tasks;
  // Focus trap is a drawer affordance: on desktop the sidebar is an inline
  // collapsible column (never modal), so trap only the mobile drawer.
  useFocusTrap(props.open && !isDesktop, asideRef, props.onClose);
  const [newCalOpen, setNewCalOpen] = useState(false);
  const [settings, setSettings] = useState<{ url: string; anchor: HTMLElement } | null>(null);
  // Saved views V2: inline save-name row, inline rename, keybind capture.
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const saveNameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<string | null>(null);
  captureRef.current = captureId;
  const rejectTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (savingView) saveNameRef.current?.focus();
  }, [savingView]);
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const { query } = parseRoutePath(hash.replace(/^#/, ''));
  const dateParam = query.get('date');
  const routeDate = dateParam && DATE_KEY.test(dateParam) ? dateParam : null;

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

  // Sidebar sizing (prefs.sidebarSize → <html data-sidebar-size>): app.css
  // scales every sidebar section off that one attribute. Mount + change (the
  // signal read in the dep array re-renders this component on change).
  useEffect(() => {
    document.documentElement.dataset.sidebarSize = prefs.value.sidebarSize;
  }, [prefs.value.sidebarSize]);

  // Saved-view keybinds (V2): document-level dispatch, gated like the §16
  // handlers (inputs/dialogs). While a row is capturing, the next safe key is
  // bound; stopImmediatePropagation swallows it before the app.tsx and
  // useShortcuts handlers (registered later — child effects run first).
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
        setViewKeybind(capturing, e.key);
        setCaptureId(null);
        return;
      }
      if (isEditableTarget(e.target) || isDialogOpen()) return;
      const view = savedViewsV2.value.find((v) => v.keybind === e.key);
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

  const commitSaveView = (): void => {
    const saved = saveCurrentView(viewName.trim() || undefined);
    push('success', `View "${saved.name}" saved`);
    setSavingView(false);
    setViewName('');
  };

  const commitRename = (): void => {
    if (renaming) renameViewV2(renaming.id, renaming.name);
    setRenaming(null);
  };

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
          during the width transition. Mobile: off-canvas drawer, unchanged. */}
      <aside
        ref={asideRef}
        aria-label="Calendar sidebar"
        class={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-(--drawer-w) shrink-0 flex-col overflow-hidden border-r border-border bg-surface transition-[transform,width] duration-200 ease-out md:static md:translate-x-0 ${
          props.open
            ? 'translate-x-0 shadow-[var(--shadow-2)] md:w-(--sidebar-w)'
            : '-translate-x-full md:w-0 md:border-r-0'
        }`}
      >
        <div class="app-sidebar-body flex min-h-0 min-w-(--sidebar-w) flex-1 flex-col">
          <div class="flex flex-col gap-1.5 px-4 pt-4 pb-2">
            <button type="button" class="btn btn-primary w-full" title="New event (N)" onClick={onNew}>
              <Icon.plus size={14} />
              New event
            </button>
          </div>
          <div class="px-3 pb-3">
            <MiniMonth routeDate={routeDate} />
          </div>
          <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Calendars">
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
          <MiniAgenda />
          <nav class="border-t border-border px-2 py-2" aria-label="Saved views">
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
            {savedViewsV2.value.map((v) => (
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
                    title={
                      v.visibility.length === 0
                        ? `${v.name} — apply (all calendars, ${v.view})`
                        : `${v.name} — apply (${v.visibility.length} ${
                            v.visibility.length === 1 ? 'calendar' : 'calendars'
                          }, ${v.view})`
                    }
                    onClick={() => applyView(v.id)}
                  >
                    <span class="min-w-0 truncate">{v.name}</span>
                    <span
                      class="shrink-0 rounded-full bg-surface-3 px-1.5 text-[10px] leading-4 text-muted tabular-nums"
                      title={
                        v.visibility.length === 0
                          ? 'All calendars visible'
                          : `${v.visibility.length} ${
                              v.visibility.length === 1 ? 'calendar' : 'calendars'
                            } visible`
                      }
                    >
                      {v.visibility.length === 0 ? 'all' : v.visibility.length}
                    </span>
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
                        rejectId === v.id
                          ? 'border-danger text-danger'
                          : 'border-border bg-surface-2 text-muted'
                      } ${
                        v.keybind || captureId === v.id
                          ? ''
                          : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                      }`}
                      title={
                        captureId === v.id
                          ? 'Press a key… (Esc cancels)'
                          : v.keybind
                            ? `Keybind ${v.keybind} — click to change`
                            : 'Set keybind'
                      }
                      aria-label={`Set keybind for ${v.name}`}
                      aria-pressed={captureId === v.id}
                      onClick={() => {
                        setRejectId(null);
                        setCaptureId((cur) => (cur === v.id ? null : v.id));
                      }}
                    >
                      {captureId === v.id ? '…' : (v.keybind ?? '·')}
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
                      onClick={() => deleteViewV2(v.id)}
                    >
                      <Icon.x size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {savedViews.value.length === 0 ? (
              savedViewsV2.value.length === 0 && (
                <p class="px-2.5 py-1.5 text-sm text-muted">No saved views — save one with + above</p>
              )
            ) : (
              savedViews.value.map((v) => (
                <div key={v.id} class="flex w-full items-center">
                  <a class="chip min-w-0 flex-1" href={`#/view/${v.id}`} title={v.name}>
                    <span class="min-w-0 truncate">{v.name}</span>
                  </a>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm icon-btn shrink-0"
                    title="Delete view"
                    aria-label={`Delete view ${v.name}`}
                    onClick={() => deleteView(v.id)}
                  >
                    <Icon.x size={13} />
                  </button>
                </div>
              ))
            )}
          </nav>
          {/* Tasks nav (footer, icon+label): pairs with the header Contacts/
              Settings icon buttons as the always-visible route to #/tasks. */}
          <nav class="border-t border-border px-2 py-2" aria-label="Tasks">
            <a
              class="chip flex w-full items-center gap-2"
              href={`#${ROUTES.tasks}`}
              title="Tasks"
              aria-current={onTasks ? 'page' : undefined}
            >
              <span class="nav-tasks-ico shrink-0" aria-hidden="true">
                <Icon.check size={11} />
              </span>
              Tasks
            </a>
          </nav>
          <AccountStatus />
          {/* Sidebar size footer control (mirrors Settings › Appearance):
              'Size' label + three square calendar-glyph buttons at increasing
              scales; pressed = active preset. */}
          <div
            class="flex items-center justify-center gap-2 border-t border-border px-4 py-1.5"
            role="group"
            aria-label="Sidebar size"
            title="Sidebar size"
          >
            <span class="text-xs text-muted">Size</span>
            <div class="flex items-center gap-1">
              {SIDEBAR_SIZES.map((size, i) => (
                <button
                  key={size}
                  type="button"
                  class={`grid size-6 place-items-center rounded transition-colors ${
                    prefs.value.sidebarSize === size
                      ? 'bg-surface-3 text-fg-strong'
                      : 'text-muted hover:bg-surface-2'
                  }`}
                  aria-pressed={prefs.value.sidebarSize === size}
                  aria-label={`Sidebar size: ${size}`}
                  onClick={() => setPrefs({ sidebarSize: size })}
                >
                  <Icon.calendar size={10 + i * 3} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
      {/* Fixed-position overlays live outside <aside>: on mobile the aside
          goes inert when closed, which would break their focus. */}
      {settings !== null && (
        <CalSettingsPopover calUrl={settings.url} anchor={settings.anchor} onClose={() => setSettings(null)} />
      )}
      <NewCalendarModal open={newCalOpen} onClose={() => setNewCalOpen(false)} />
    </>
  );
}
