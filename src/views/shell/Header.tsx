/** @jsxImportSource preact */
/**
 * Global header chrome (design.md §4): 48px row with menu button (mobile
 * drawer), wycal wordmark, spacer, 240px search box (typing writes the `q`
 * hash-query param on the calendar route, debounced ~300ms per settled term),
 * theme toggle (light → dark → auto, persisted via the prefs store),
 * contacts + settings links, and the `?` keyboard-shortcuts button.
 *
 * The `/` key is owned by the global handler (app.tsx, CONTRACTS §16), which
 * pings `wycal:search` on window; this component focuses the search box when
 * it arrives. View-switching keys belong to the calendar view.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { IconComponent } from '../../ui/icons';
import { Icon } from '../../ui/icons';
import { setPrefs, prefs } from '../../stores/prefs';
import type { Theme } from '../../stores/prefs';
import { helpOpen } from '../../stores/ui';
import { gotoCalendarQuery, parseRoutePath, ROUTES, useHash } from '../../routes';

const NEXT_THEME: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };
const THEME_ICON: Record<Theme, IconComponent> = {
  light: Icon.sun,
  dark: Icon.moon,
  auto: Icon.sunMoon,
};

export function Header(props: { onMenu: () => void }) {
  const hash = useHash();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [searchValue, setSearchValue] = useState('');
  // Debounced hash write: one push per settled search term (~300ms).
  const pushTimerRef = useRef<number | undefined>(undefined);

  const { path, query } = parseRoutePath(hash.replace(/^#/, ''));
  const routeQuery = query.get('q') ?? '';

  // Hash is the source of truth for the visible query: typing round-trips
  // through it, and external edits (route changes) reset the box.
  useEffect(() => {
    setSearchValue(routeQuery);
  }, [routeQuery]);

  // Drop a pending debounced write on unmount.
  useEffect(() => () => window.clearTimeout(pushTimerRef.current), []);

  // The global handler (app.tsx) owns the `/` key and pings `wycal:search`
  // (twice — see pingRouteView; focusing twice is harmless).
  useEffect(() => {
    const onSearch = (): void => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('wycal:search', onSearch);
    return () => window.removeEventListener('wycal:search', onSearch);
  }, []);

  const onSearchInput = (e: Event): void => {
    const value = (e.target as HTMLInputElement).value;
    setSearchValue(value);
    const q = value.trim();
    window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => gotoCalendarQuery({ q: q ? q : null }), 300);
  };

  const onSearchKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    window.clearTimeout(pushTimerRef.current);
    setSearchValue('');
    gotoCalendarQuery({ q: null });
    searchRef.current?.blur();
  };

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
      <a
        href={`#${ROUTES.calendar}`}
        class="flex shrink-0 items-center gap-2"
        aria-label="wycal — calendar"
      >
        <span class="size-2.5 rounded-full bg-accent" aria-hidden="true" />
        <span class="text-lg font-bold tracking-tight text-fg-strong">wycal</span>
      </a>
      <div class="flex-1" aria-hidden="true" />
      <div class="relative w-32 min-w-0 sm:w-60">
        <Icon.search
          size={14}
          class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
        />
        <input
          ref={searchRef}
          type="search"
          class="input h-7 py-0 pr-2 pl-8 text-sm"
          placeholder="Search events"
          aria-label="Search events"
          title="Search (/)"
          value={searchValue}
          onInput={onSearchInput}
          onKeyDown={onSearchKeydown}
        />
      </div>
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
        href={`#${ROUTES.contacts}`}
        aria-label="Contacts"
        title="Contacts"
        aria-current={path === ROUTES.contacts ? 'page' : undefined}
      >
        <Icon.users size={16} />
      </a>
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
