/** Hash route paths (CONTRACTS §6). Rendered under hash history: `#/contacts`, … */
import { useEffect, useState } from 'preact/hooks';

export const ROUTES = {
  /** Calendar — the default route. View state rides in the hash query: `#/?view=week&date=2026-10-09&n=3`. */
  calendar: '/',
  contacts: '/contacts',
  settings: '/settings',
  /** Tasks (todos) — CONTRACTS §15. */
  tasks: '/tasks',
  /** Match search over events + todos; the query rides as `?q=` — CONTRACTS §15. */
  search: '/search',
  /** Saved composite view by id (`#/view/:id`) — CONTRACTS §15. */
  savedView: '/view/:id',
} as const;

/** Split a hash-internal path into its route path and query params. */
export function parseRoutePath(path: string): {
  path: string;
  query: URLSearchParams;
} {
  const qIndex = path.indexOf('?');
  const routePath = qIndex === -1 ? path : path.slice(0, qIndex);
  const search = qIndex === -1 ? '' : path.slice(qIndex + 1);
  return {
    path: routePath || ROUTES.calendar,
    query: new URLSearchParams(search),
  };
}

// --- Shared hash plumbing (Header + Sidebar) --------------------------------

/** Re-render on hash navigation; returns the raw location.hash. */
export function useHash(): string {
  const [hash, setHash] = useState<string>(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return hash;
}

/** Patch the calendar route's hash query, preserving its other params. */
export function gotoCalendarQuery(patch: Record<string, string | null>): void {
  const { path, query } = parseRoutePath(window.location.hash.replace(/^#/, ''));
  const params = path === ROUTES.calendar ? query : new URLSearchParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  window.location.hash = `/${qs ? `?${qs}` : ''}`;
}
