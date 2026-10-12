import { signal } from '@preact/signals';
import type { AgendaGroup, AgendaRange } from '../lib/agenda/agendaModel';

export type Theme = 'light' | 'dark' | 'auto';
export type Density = 'compact' | 'cozy';
/** Sidebar chrome scale (design.md §4): stamped as <html data-sidebar-size>;
 *  app.css scales every sidebar section off that attribute. */
export type SidebarSize = 'compact' | 'default' | 'large';
/** Which edge of the window the sidebar column hugs (§nav-revamp). */
export type SidebarSide = 'left' | 'right';
/** Agenda todo STATUS filter chips (§nav-revamp agenda mode). */
export type AgendaStatusFilter = 'all' | 'todo' | 'doing' | 'done';
/** Agenda todo PRIORITY filter chips (§nav-revamp agenda mode). */
export type AgendaPriorityFilter = 'all' | 'A' | 'B' | 'C';
/** Schedule sub-view names the mode switcher remembers (prefs.lastScheduleView). */
const SCHEDULE_VIEWS: Record<string, true> = {
  day: true, '3d': true, '5d': true, week: true, '2weeks': true, month: true,
};
export type FirstDay = 0 | 1;

/** Shape of the persisted preferences object (CONTRACTS §4, §13). */
interface Prefs {
  theme: Theme;
  firstDay: FirstDay;
  hour12: boolean;
  defaultView: string;
  defaultDurationMin: number;
  density: Density;
  /** Sidebar sizing preset; absent in stored JSON → 'default'. */
  sidebarSize: SidebarSize;
  /** Sidebar drag-resize width in px (§22); absent → 264. */
  sidebarWidth?: number;
  /** Time-axis zoom in minutes per slot (§22 ladder); absent → 30.
   *  Legacy string presets migrate in loadPrefs ('overview'/'comfortable'→30,
   *  'detailed'→15). */
  zoom?: number;
  /** Provision Inbox/Birthdays calendars per account when missing (§13). */
  autoProvision?: boolean;
  /** Agenda view window in days (§agenda chips); absent → 14. */
  agendaRange?: AgendaRange;
  /** Agenda view grouping (§agenda chips); absent → 'day'. */
  agendaGroup?: AgendaGroup;
  /** Show todo rows in the agenda view (§agenda chip); absent → true. */
  agendaTodos?: boolean;
  /** Show event rows in the agenda view (§nav-revamp); absent → true. */
  agendaEvents?: boolean;
  /** Agenda todo status filter (§nav-revamp); absent → 'all'. */
  agendaStatusFilter?: AgendaStatusFilter;
  /** Agenda todo priority filter (§nav-revamp); absent → 'all'. */
  agendaPriorityFilter?: AgendaPriorityFilter;
  /** Last non-agenda schedule sub-view; the mode switcher restores it. Absent → 'week'. */
  lastScheduleView?: string;
  /** Sidebar column edge (§nav-revamp); absent → 'right'. */
  sidebarSide: SidebarSide;
  /** Draggable section heights in px, by sidebar section id (§nav-revamp);
   *  absent key → section sizes to content (flex auto). */
  sidebarSectionHeights?: Record<string, number>;
}

const PREFS_STORAGE_KEY = 'wycal.prefs';

const DEFAULT_PREFS: Readonly<Prefs> = {
  theme: 'auto',
  firstDay: 1,
  hour12: false,
  defaultView: 'timeGridWeek',
  defaultDurationMin: 60,
  density: 'compact',
  sidebarSize: 'default',
  sidebarWidth: 264,
  zoom: 30,
  autoProvision: true,
  agendaRange: 14,
  agendaGroup: 'day',
  agendaTodos: true,
  agendaEvents: true,
  agendaStatusFilter: 'all',
  agendaPriorityFilter: 'all',
  lastScheduleView: 'week',
  sidebarSide: 'right',
  sidebarSectionHeights: {},
};

/** Keeps only finite-number entries of a stored heights map (localStorage
 *  boundary — the shape is untrusted). */
function sanitizeSectionHeights(raw: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function loadPrefs(): Prefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const stored: unknown = JSON.parse(raw);
    const s = (stored ?? {}) as Partial<Record<keyof Prefs, unknown>>;
    return {
      theme:
        s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto'
          ? s.theme
          : DEFAULT_PREFS.theme,
      firstDay: s.firstDay === 0 || s.firstDay === 1 ? s.firstDay : DEFAULT_PREFS.firstDay,
      hour12: typeof s.hour12 === 'boolean' ? s.hour12 : DEFAULT_PREFS.hour12,
      defaultView:
        typeof s.defaultView === 'string' && s.defaultView
          ? s.defaultView
          : DEFAULT_PREFS.defaultView,
      defaultDurationMin:
        typeof s.defaultDurationMin === 'number' && Number.isFinite(s.defaultDurationMin) && s.defaultDurationMin > 0
          ? s.defaultDurationMin
          : DEFAULT_PREFS.defaultDurationMin,
      density: s.density === 'compact' || s.density === 'cozy' ? s.density : DEFAULT_PREFS.density,
      sidebarSize:
        s.sidebarSize === 'compact' || s.sidebarSize === 'large'
          ? s.sidebarSize
          : DEFAULT_PREFS.sidebarSize,
      sidebarWidth:
        typeof s.sidebarWidth === 'number' && Number.isFinite(s.sidebarWidth)
          ? Math.min(420, Math.max(200, s.sidebarWidth))
          : DEFAULT_PREFS.sidebarWidth,
      // §22: zoom is minutes; legacy §22 presets migrate to rungs.
      zoom:
        typeof s.zoom === 'number' && Number.isFinite(s.zoom) && s.zoom >= 5 && s.zoom <= 60
          ? s.zoom
          : s.zoom === 'comfortable' || s.zoom === 'overview'
            ? 30
            : s.zoom === 'detailed'
              ? 15
              : DEFAULT_PREFS.zoom,
      autoProvision: typeof s.autoProvision === 'boolean' ? s.autoProvision : DEFAULT_PREFS.autoProvision,
      agendaRange:
        s.agendaRange === 7 || s.agendaRange === 14 || s.agendaRange === 30
          ? s.agendaRange
          : DEFAULT_PREFS.agendaRange,
      agendaGroup:
        s.agendaGroup === 'day' || s.agendaGroup === 'calendar' || s.agendaGroup === 'flat'
          ? s.agendaGroup
          : DEFAULT_PREFS.agendaGroup,
      agendaTodos: typeof s.agendaTodos === 'boolean' ? s.agendaTodos : DEFAULT_PREFS.agendaTodos,
      agendaEvents: typeof s.agendaEvents === 'boolean' ? s.agendaEvents : DEFAULT_PREFS.agendaEvents,
      agendaStatusFilter:
        s.agendaStatusFilter === 'todo' || s.agendaStatusFilter === 'doing' || s.agendaStatusFilter === 'done'
          ? s.agendaStatusFilter
          : DEFAULT_PREFS.agendaStatusFilter,
      agendaPriorityFilter:
        s.agendaPriorityFilter === 'A' || s.agendaPriorityFilter === 'B' || s.agendaPriorityFilter === 'C'
          ? s.agendaPriorityFilter
          : DEFAULT_PREFS.agendaPriorityFilter,
      lastScheduleView:
        typeof s.lastScheduleView === 'string' && SCHEDULE_VIEWS[s.lastScheduleView]
          ? s.lastScheduleView
          : DEFAULT_PREFS.lastScheduleView,
      sidebarSide: s.sidebarSide === 'left' ? 'left' : DEFAULT_PREFS.sidebarSide,
      sidebarSectionHeights:
        typeof s.sidebarSectionHeights === 'object' &&
        s.sidebarSectionHeights !== null &&
        !Array.isArray(s.sidebarSectionHeights)
          ? sanitizeSectionHeights(s.sidebarSectionHeights)
          : DEFAULT_PREFS.sidebarSectionHeights,
    };
  } catch (err) {
    console.warn('wycal: could not read prefs, using defaults', err);
    return { ...DEFAULT_PREFS };
  }
}

/** Global preferences signal, persisted to localStorage under 'wycal.prefs'. */
export const prefs = signal<Prefs>(loadPrefs());

/** Merge a patch into prefs and persist. */
export function setPrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs.value));
  } catch (err) {
    console.warn('wycal: could not persist prefs', err);
  }
}
