/** @jsxImportSource preact */
/**
 * App shell (CONTRACTS §6, design.md §4): fixed sidebar + 48px global header
 * chrome + routed main pane. Mounts the toast host and event editor at the
 * root, boots the sync engine on mount, and stamps the theme on <html>. Owns
 * the global keyboard handler (CONTRACTS §16) and the help overlay it opens.
 */
import { useEffect } from 'preact/hooks';
import { Router, Route } from 'preact-router';
import type { CustomHistory } from 'preact-router';
import { prefs } from './stores/prefs';
import { collections, toggleCalendar } from './stores/calendars';
import {
  helpOpen,
  isDialogOpen,
  isEditableTarget,
  pingRouteView,
  requestNewEvent,
  sidebarOpen,
  toggleSidebar,
} from './stores/ui';
import { notesOpen } from './stores/notes';
import { accounts } from './stores/accounts';
import { ROUTES, parseRoutePath, useHash } from './routes';
import { SignIn, signInActive } from './views/auth/SignIn';
import { CalendarView } from './views/calendar/CalendarView';
import { ContactsView } from './views/contacts/ContactsView';
import { ScratchNotes } from './views/notes/ScratchNotes';
import { SettingsView } from './views/settings/SettingsView';
import SavedComposite from './views/search/SavedComposite';
import { EventEditor } from './views/event-editor/EventEditor';
import { TodoEditor } from './views/tasks/TodoEditorModal';
import { QuickAddDialog, openQuickAdd } from './views/quickadd/QuickAddDialog';
import {
  CommandPalette,
  closeCommandPalette,
  isCommandPaletteOpen,
  openCommandPalette,
} from './views/command/CommandPalette';
import { Header } from './views/shell/Header';
import { Sidebar } from './views/shell/Sidebar';
import { ToastHost } from './ui/Toasts';
import { HelpOverlay } from './ui/HelpOverlay';
import { initSync } from './lib/sync/engine';
import { startSync } from './lib/sync/scheduler';

interface HashLocation {
  pathname: string;
  search: string;
}

/** Parse `#/contacts?x=1` into a router Location ('' -> '/'). */
function parseHash(hash: string): HashLocation {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qIndex = raw.indexOf('?');
  const rawPath = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const pathname = rawPath || '/';
  return {
    pathname: pathname.startsWith('/') ? pathname : `/${pathname}`,
    search: qIndex === -1 ? '' : raw.slice(qIndex),
  };
}

function toHashPath(path: string): string {
  const raw = path.startsWith('#') ? path.slice(1) : path;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** Hash history adapter so preact-router runs on `#/…` URLs (CONTRACTS §6). */
const hashHistory: CustomHistory = {
  get location(): HashLocation {
    return parseHash(window.location.hash);
  },
  listen(onLocationChange): () => void {
    const onHashChange = () => onLocationChange(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  },
  push(path: string): void {
    window.location.hash = toHashPath(path);
  },
  replace(path: string): void {
    window.history.replaceState(null, '', `#${toHashPath(path)}`);
  },
};

/**
 * Calendar route: renders the saved composite when the hash query carries
 * `saved=<id>` (CONTRACTS §15), the calendar view otherwise.
 */
function CalendarRoute() {
  const hash = useHash();
  const { query } = parseRoutePath(hash.replace(/^#/, ''));
  const savedId = query.get('saved');
  return savedId ? <SavedComposite savedId={savedId} /> : <CalendarView />;
}

export function App() {
  // Sidebar/drawer visibility lives in stores/ui so the global `X` keybind
  // (CONTRACTS §16) can toggle it.
  const drawerOpen = sidebarOpen.value;

  // First-run gate (CONTRACTS §24): no accounts yet → the sign-in card stands
  // in for the whole shell. Any account — even locked or sync-errored — keeps
  // the shell; signInActive only holds the card up while its submit is in
  // flight or showing its error, so the inline helper stays reachable.
  const needsSignIn = accounts.value.length === 0 || signInActive.value;

  // Theme sync: stamp the raw theme ('light' | 'dark' | 'auto') on <html>;
  // 'auto' resolves to dark inside theme.css via prefers-color-scheme.
  useEffect(() => {
    const applyTheme = () => {
      document.documentElement.dataset.theme = prefs.value.theme;
    };
    applyTheme();
    return prefs.subscribe(applyTheme);
  }, []);

  // §nav-revamp: the Tasks route is gone (merged into Agenda) — any stale
  // #/tasks link lands on the agenda mode instead.
  useEffect(() => {
    const redirect = (): void => {
      const { path } = parseRoutePath(window.location.hash.replace(/^#/, ''));
      if (path === ROUTES.tasks) window.location.hash = `#/?view=agenda`;
    };
    redirect();
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
  }, []);

  // Density sync (CONTRACTS §4): stamp 'compact' | 'cozy' on <html>; app.css
  // keeps cozy as the default look and tightens ~10% under [data-density].
  useEffect(() => {
    const applyDensity = () => {
      document.documentElement.dataset.density = prefs.value.density;
    };
    applyDensity();
    return prefs.subscribe(applyDensity);
  }, []);

  // Sync engine: discovery + initial collection sync per account, then the
  // 60s poller (both idempotent; CONTRACTS §4).
  useEffect(() => {
    initSync();
    startSync();
  }, []);

  // Global keyboard shortcuts (CONTRACTS §16, §nav-revamp, §wave-14): ⌘K
  // command palette · n new event · Shift+N quick-add a todo directly ·
  // c/C new contact/calendar · / command palette (superset of the old
  // sidebar-search focus) · s settings · x sidebar · \ scratch notes · ?
  // help · 1–9 toggle calendar n · q close topmost dialog · Q quick-add
  // dialog. Route-aware
  // (works on every route), input-gated, and dialog-gated (`q` still fires so
  // it can close the dialog). Calendar-scope keys live in useShortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // ⌘K / Ctrl+K toggles the command palette from anywhere (even inside
      // inputs — it is a chord, not a typed character). Never opens on top of
      // another dialog, but always closes itself.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (isCommandPaletteOpen()) closeCommandPalette();
        else if (!isDialogOpen()) openCommandPalette();
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const dialogUp = isDialogOpen();
      switch (e.key) {
        case 'n':
          if (!dialogUp) requestNewEvent();
          break;
        case 'N':
          // §nav-revamp: Shift+N opens quick-add in todo mode directly (the
          // Tasks route is gone).
          if (!dialogUp) openQuickAdd('todo');
          break;
        case 'c':
          if (!dialogUp) {
            if (window.location.hash !== `#${ROUTES.contacts}`) {
              window.location.hash = `#${ROUTES.contacts}`;
            }
            pingRouteView('wycal:newcontact');
          }
          break;
        case 'C':
          if (!dialogUp) pingRouteView('wycal:newcalendar');
          break;
        case '/':
          // §wave-14: opens the command palette — a superset of the old
          // sidebar-search focus (typing searches the same engine; NL creates
          // events/tasks/contacts on top). The sidebar search box keeps its
          // click focus (the palette owns the keyboard entry points).
          if (!dialogUp) openCommandPalette();
          break;
        case 's':
          if (!dialogUp) window.location.hash = `#${ROUTES.settings}`;
          break;
        case 'x':
          if (!dialogUp) toggleSidebar();
          break;
        case '?':
          if (!dialogUp) helpOpen.value = true;
          break;
        case '1': case '2': case '3': case '4': case '5':
        case '6': case '7': case '8': case '9': {
          if (!dialogUp) {
            // Numbering follows the sidebar's calendar list (calendars only).
            const cal = collections.value.filter((c) => c.kind === 'calendar')[
              Number(e.key) - 1
            ];
            if (cal) toggleCalendar(cal.url);
          }
          break;
        }
        case '\\':
          // Scratch notes (design.md §9.8): gated like the other keys, but
          // backslash closes the panel while it is open.
          if (!dialogUp || notesOpen.value) notesOpen.value = !notesOpen.value;
          break;
        case 'q': {
          // Close the topmost dialog: synthesize Escape for modal focus traps
          // (Modal/EventEditor listen for a plain Escape keydown).
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
          break;
        }
        case 'Q':
          // Global quick-add dialog (CONTRACTS §16); gated on open dialogs so
          // it never fires while an editor is up (lowercase q closes those).
          if (!dialogUp) openQuickAdd();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // §24 gate: render the sign-in card INSTEAD of the shell. Hooks above stay
  // mounted either way, so initSync/scheduler already run and pick up the
  // first account the moment it lands.
  if (needsSignIn) return <SignIn />;

  return (
    <div class="flex h-dvh overflow-hidden bg-bg text-fg">
      {/* §nav-revamp: flex `order` hugs the sidebar to prefs.sidebarSide
          (default 'right' = main column first, sidebar last). The aside sets
          the matching order itself (Sidebar.tsx). */}
      <div
        class="flex min-w-0 flex-1 flex-col"
        style={{ order: prefs.value.sidebarSide === 'left' ? 2 : 1 }}
      >
        <Header onMenu={() => (sidebarOpen.value = true)} />
        <main class="min-h-0 max-md:pb-[env(safe-area-inset-bottom)] flex-1 overflow-hidden">
          <Router history={hashHistory}>
            <Route path={ROUTES.calendar} component={CalendarRoute} />
            <Route path={ROUTES.contacts} component={ContactsView} />
            <Route path={ROUTES.settings} component={SettingsView} />
            <Route path={ROUTES.savedView} component={SavedComposite} />
            <Route default component={CalendarRoute} />
          </Router>
        </main>
      </div>
      <Sidebar open={drawerOpen} onClose={() => (sidebarOpen.value = false)} />
      <ToastHost />
      <ScratchNotes />
      <EventEditor />
      <TodoEditor />
      <QuickAddDialog />
      <CommandPalette />
      <HelpOverlay />
    </div>
  );
}
