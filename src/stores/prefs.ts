import { signal } from '@preact/signals';

export type Theme = 'light' | 'dark' | 'auto';
export type Density = 'compact' | 'cozy';
/** Sidebar chrome scale (design.md §4): stamped as <html data-sidebar-size>;
 *  app.css scales every sidebar section off that attribute. */
export type SidebarSize = 'compact' | 'default' | 'large';
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
};

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
