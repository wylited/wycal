/** @jsxImportSource preact */
/**
 * Global header chrome (design.md §4, §nav-revamp): 48px row with menu button
 * (mobile drawer), the [Schedule | Agenda | Contacts] mode switcher bound to
 * the hash (schedule restores prefs.lastScheduleView, default week; agenda is
 * `#/?view=agenda`; contacts is `#/contacts`), wycal wordmark, spacer, theme
 * toggle (light → dark → auto, persisted via the prefs store), settings link,
 * and the `?` keyboard-shortcuts button.
 * Search lives at the top of the sidebar now (SidebarSearch); '/' and ⌘K are
 * dispatched by app.tsx §16 and focused there. View-switching keys belong to
 * the calendar view.
 */
import { useEffect } from 'preact/hooks';
import type { IconComponent } from '../../ui/icons';
import { Icon } from '../../ui/icons';
import { setPrefs, prefs } from '../../stores/prefs';
import type { Theme } from '../../stores/prefs';
import { helpOpen } from '../../stores/ui';
import { parseRoutePath, ROUTES, useHash } from '../../routes';

const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };
const THEME_ICON: Record<Theme, IconComponent> = {
  light: Icon.sun,
  dark: Icon.moon,
  auto: Icon.sunMoon,
};

/** Top-level shell modes (§nav-revamp); mirrors Sidebar.tsx's derivation. */
type ShellMode = 'schedule' | 'agenda' | 'contacts';

/** Schedule sub-view names the mode switcher may restore. */
const SCHEDULE_VIEWS: Record<string, true> = {
  day: true, '3d': true, '5d': true, week: true, '2weeks': true, month: true,
};

const MODES: Array<{ id: ShellMode; label: string; icon: IconComponent }> = [
  { id: 'schedule', label: 'Schedule', icon: Icon.calendar },
  { id: 'agenda', label: 'Agenda', icon: Icon.menu },
  { id: 'contacts', label: 'Contacts', icon: Icon.users },
];

/** Current shell mode from the hash (settings/saved-composites lean schedule). */
function modeOfHash(hash: string): { mode: ShellMode; scheduleView: string | null } {
  const { path, query } = parseRoutePath(hash.replace(/^#/, ''));
  const view = query.get('view');
  if (path === ROUTES.contacts) return { mode: 'contacts', scheduleView: null };
  if (path === ROUTES.calendar && view === 'agenda') return { mode: 'agenda', scheduleView: null };
  return { mode: 'schedule', scheduleView: view !== null && SCHEDULE_VIEWS[view] ? view : null };
}

/** Hash the switcher navigates to for a mode (§nav-revamp mode→hash map). */
function hashForMode(mode: ShellMode): string {
  if (mode === 'agenda') return '/?view=agenda';
  if (mode === 'contacts') return ROUTES.contacts;
  return `/?view=${prefs.value.lastScheduleView ?? 'week'}`;
}

export function Header(props: { onMenu: () => void }) {
  const hash = useHash();
  const { mode, scheduleView } = modeOfHash(hash);
  const { path } = parseRoutePath(hash.replace(/^#/, ''));

  // Remember the last schedule sub-view so leaving Schedule mode and coming
  // back restores it (prefs.lastScheduleView, default 'week').
  useEffect(() => {
    if (scheduleView && scheduleView !== (prefs.value.lastScheduleView ?? 'week')) {
      setPrefs({ lastScheduleView: scheduleView });
    }
  }, [scheduleView]);

  const theme = prefs.value.theme;
  const nextTheme = NEXT_THEME[theme];
  const ThemeIcon = THEME_ICON[theme];

  return (
    <header class="flex h-(--header-h) shrink-0 items-center gap-2 border-b border-border bg-bg px-3">
      <button
        type="button"
        class="btn btn-ghost btn-sm icon-btn md:hidden"
        aria-label="Open menu"
        title="Menu"
        onClick={props.onMenu}
      >
        <Icon.menu />
      </button>
      <nav class="mode-seg flex shrink-0 items-center gap-0.5" role="group" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            class="mode-seg-btn flex items-center gap-1.5"
            aria-pressed={mode === m.id}
            title={`${m.label} mode`}
            onClick={() => {
              window.location.hash = hashForMode(m.id);
            }}
          >
            <m.icon size={14} />
            {m.label}
          </button>
        ))}
      </nav>
      <a
        href={`#${ROUTES.calendar}`}
        class="flex shrink-0 items-center gap-2"
        aria-label="wycal — calendar"
      >
        <span class="size-2.5 rounded-full bg-accent" aria-hidden="true" />
        <span class="text-lg font-bold tracking-tight text-fg-strong">wycal</span>
      </a>
      <div class="flex-1" aria-hidden="true" />
      <button
        type="button"
        class="btn btn-ghost btn-sm icon-btn shrink-0"
        aria-label={`Theme: ${theme} — switch to ${nextTheme}`}
        title={`Theme: ${theme}`}
        onClick={() => setPrefs({ theme: nextTheme })}
      >
        <ThemeIcon size={16} />
      </button>
      <a
        class="btn btn-ghost btn-sm icon-btn shrink-0"
        href={`#${ROUTES.settings}`}
        aria-label="Settings"
        title="Settings (S)"
        aria-current={path === ROUTES.settings ? 'page' : undefined}
      >
        <Icon.settings size={16} />
      </a>
      <button
        type="button"
        class="btn btn-ghost btn-sm icon-btn shrink-0 text-base font-semibold"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => (helpOpen.value = true)}
      >
        ?
      </button>
    </header>
  );
}
