# wycal CONTRACTS.md — the law

Bun + Vite + Preact + TypeScript SPA, no backend of our own; talks CalDAV/CardDAV to Radicale through a same-origin proxy (`/dav/`). Everything here is fixed; agents implement against it, never around it.

## 1. Toolchain & commands

- Package manager/runner: **bun** (`bun install`, `bun run dev` etc.). Runtime deps (exact set, no more): `preact`, `@preact/signals`, `preact-router`, `date-fns`, `rrule`, `@fullcalendar/core`, `@fullcalendar/interaction`, `@fullcalendar/daygrid`, `@fullcalendar/timegrid`, `@fullcalendar/list`, `@fullcalendar/multimonth`, `@fullcalendar/react`, `@fontsource/atkinson-hyperlegible`. Dev: `vite`, `@preact/preset-vite`, `typescript`, `tailwindcss@^4`, `@tailwindcss/vite`, `bun-types`.
- React compat: `vite.config.ts` resolves `react` → `preact/compat` (jsxImportSource preact elsewhere). `@fullcalendar/react` runs under that alias. Components are `.tsx` with `/** @jsxImportSource preact */`. `tsconfig.json` ALSO needs `paths`: `react` → `./node_modules/preact/compat`, `react-dom` → `./node_modules/preact/compat`, `react/jsx-runtime` → `./node_modules/preact/jsx-runtime` (with `skipLibCheck: true`), or `@fullcalendar/react`'s React type imports resolve to real React types.
- FullCalendar is pinned `@fullcalendar/*@^6.1.21`. **v6 ships NO css files** — never `import '@fullcalendar/*/index.css'` (build breaker; v7-only habit). v6 injects its own `<style data-fullcalendar>` at runtime; theme exclusively by overriding `--fc-*` custom properties in `styles/theme.css` scoped under `.fc`.
- Ports: Vite dev `5173`, preview `4173`, Radicale `5232` (127.0.0.1 only). Vite `server.proxy` AND `preview.proxy`: `'/dav': { target: 'http://127.0.0.1:5232', changeOrigin: false }` — Radicale must be configured with `base_prefix = /dav`? NO: proxy uses `rewrite: p => p.replace(/^\/dav/, '')` so Radicale stays prefix-free.
- Scripts: `dev`, `build` (`tsc -b && vite build`), `preview`, `test` (`bun test`).

## 2. Module tree (exact)

```
src/
  main.tsx               mount + router + theme sync
  app.tsx                shell layout (header/sidebar/drawer/<router outlets>) + global keybinds
  routes.ts              hash route defs (ROUTES, parseRoutePath, useHash, gotoCalendarQuery)
  styles/theme.css       Ayu tokens (design.md §1–3) + FullCalendar --fc-* mapping + base layer
  styles/app.css         tailwind entry (@import "tailwindcss") + component classes (.btn, .input, .chip, .card, .todo-row, …)
  ui/                    shared primitives: icons.tsx, Modal.tsx (Modal + useFocusTrap), Toasts.tsx (host), Segmented.tsx, HelpOverlay.tsx
  lib/
    ics/                 types.ts parse.ts serialize.ts tz.ts recurrence.ts expand.ts (+ ics.test.ts)
    caldav/              client.ts types.ts xml.ts (+ xml.test.ts)
    vcard/               types.ts parse.ts serialize.ts text.ts (+ vcard.test.ts)
    sync/                engine.ts scheduler.ts discovery.ts
    util/                date.ts id.ts colors.ts (PALETTE, eventColorFor, hexToRgba)
  stores/                prefs.ts accounts.ts calendars.ts caldefaults.ts events.ts todos.ts contacts.ts savedviews.ts toasts.ts ui.ts
  views/
    calendar/            CalendarView.tsx (FullCalendar host + toolbar + hash state), CalendarEmptyState.tsx,
                         PeriodPickers.tsx (§9.2 month/year dropdowns), ScopeModal.tsx (recurring-edit scope),
                         useCalendarEvents.ts (store→FullCalendar feed), useCalendarMove.ts (drag/resize), useShortcuts.ts
    event-editor/        EventEditor.tsx editorState.ts
    contacts/            ContactsView.tsx ContactEditor.tsx ContactRows.tsx
    search/              SearchMatchView.tsx searchEngine.ts SavedComposite.tsx
    settings/            SettingsView.tsx
    shell/               Header.tsx Sidebar.tsx MiniMonth.tsx CalSettingsPopover.tsx NewCalendarModal.tsx
    tasks/               TasksView.tsx tasksModel.ts
```

## 3. Data-layer API (frozen)

`src/lib/ics/types.ts`:
```ts
interface IcsEvent { uid: string; recurrenceId?: string /* UTC ISO or floating date */; summary: string; location?: string; description?: string; start: IcsDate; end: IcsDate; allDay: boolean; rrule?: string /* raw RRULE */; exdates: IcsDate[]; organizer?: string; attendees: string[]; alarms: { trigger: string }[]; color?: string; raw?: string }
type IcsDate = { utc: string /* ISO UTC instant */; tzid?: string; floating?: boolean; date?: string /* YYYY-MM-DD when all-day */ }
```
`parse.ts`: `parseIcs(text: string): { events: IcsEvent[]; timezones: Map<string, string> }` — folds lines, handles VEVENT (+ VALARM, RECURRENCE-ID overrides as separate events), VTIMEZONE blocks captured raw. Properties with parameters (`DTSTART;TZID=…:…`, `DTSTART;VALUE=DATE`) handled; X- props preserved in raw. `serialize.ts`: `serializeIcsEvent(ev: IcsEvent, opts: { method?: string; prodId?: string }): string` — emits VCALENDAR/VEVENT w/ CRLF, escapes `\ , ; \n`, folds >75 octets.
`tz.ts`: `tzTimeToUtc(local: string, tzid: string): string` and `utcToTzTime(utc: string, tzid: string): string` via `Intl.DateTimeFormat` parts (IANA TZIDs; unknown TZID → treat as floating/UTC + console.warn).
`recurrence.ts`: `rruleFromEvent(ev): RRuleSet | null` (RRULE + EXDATEs via `rrule.js`); `expand.ts`: `expandEvents(base: IcsEvent, overrides: Map<string, IcsEvent>, range: {start: string; end: string}): IcsEvent[]` — returns concrete occurrences in [start,end), applying overrides keyed by recurrenceId; occurrence gets `recurrenceId` set + provenance flags.

`src/lib/caldav/types.ts`:
```ts
interface DavAccount { id: string; url: string /* origin + /dav prefix, e.g. http://127.0.0.1:5173/dav — identity only; the client routes requests through the page's own origin + /dav */; username: string; password: string /* secret resolvable in this tab, '' when none */; rememberPassword: boolean; needsPassword: boolean /* derived, never persisted */ }
interface DavCollection { url: string; name: string; color?: string; kind: 'calendar' | 'addressbook'; components: ('VEVENT' | 'VTODO' | 'VCARD')[]; etag?: string }
interface SyncResult { token: string; changedHrefs: string[]; deletedHrefs: string[] }
```
`client.ts` class `CaldavClient` (constructed per account): `discoverPrincipal(): Promise<string>` (PROPFIND `current-user-principal` at `/`), `discoverHomeSets(principal: string): Promise<{ calendarHome?: string; contactHome?: string }>` (PROPFIND `calendar-home-set` + `addressbook-home-set`), `listCollections(home: string): Promise<DavCollection[]>` (PROPFIND depth 1, resourcetype + displayname + calendar-color + supported-component-set), `syncCollection(url: string, token?: string): Promise<SyncResult>` (sync-collection REPORT w/ sync-token, getetag), `getObjects(hrefUrls: string[]): Promise<{ href: string; etag: string; data: string }[]>` (calendar-multiget/addressbook-multiget REPORT), `putObject(href: string, body: string, etag?: string): Promise<string /* new etag */>` (PUT, If-Match when editing, If-None-Match: * when creating), `deleteObject(href: string, etag: string): Promise<void>`, `mkcol(url: string, opts: { name: string; kind: 'calendar' | 'addressbook'; color?: string }): Promise<void>`. All requests: `Authorization: Basic`, `Depth`/`Content-Type: application/xml; charset=utf-8` where needed, `Prefer: return=minimal` on PUT. Errors throw `DavError extends Error { status?: number }`. `xml.ts`: tiny build/parse helpers (DOMParser), no deps.

`src/lib/vcard`: `parseVcf(text: string): Vcard[]`, `serializeVcard(v: Vcard): string`; `Vcard { uid: string; fn: string; names?: { family; given; middle?; prefix?; suffix? }; emails: { value: string; types: string[] }[]; tels: { value: string; types: string[] }[]; org?: string; title?: string; note?: string; photo?: string /* data: URI */; addresses: { value: string; types: string[] }[]; rev?: string; raw: string }` (4.0, PHOTO as data URI).

## 4. Stores (signals, `@preact/signals`)

- `prefs.ts`: `prefs` signal `{ theme: 'light'|'dark'|'auto'; firstDay: 0|1; hour12: boolean; defaultView: string; defaultDurationMin: number; density: 'compact'|'cozy' }` persisted `localStorage 'wycal.prefs'`; `setPrefs(patch)`.
- `accounts.ts`: `accounts` signal `DavAccount[]`; identity (id/url/username/rememberPassword) persists to `localStorage 'wycal.accounts'` — never a password (legacy plaintext rows are dropped on load); secrets live in memory + `sessionStorage 'wycal.secrets'` (id→password), reaching `localStorage 'wycal.secrets.remembered'` (plain text) only on the explicit Remember opt-in; `addAccount/removeAccount/setAccountPassword/setRememberPassword`; `needsPassword` is derived per tab (missing secret → true); unlock replaces the account object so the engine effect resumes sync.
- `calendars.ts`: `collections` signal `DavCollection[]`, `visibleCalendars` computed (set of URLs persisted 'wycal.visible'), `toggleCalendar`, `collectionColor(cal)`.
- `events.ts`: `EventRecord { key: string /* calendarUrl + '/' + uid [+ '#' + recurrenceId] */; calendarUrl: string; href: string; etag: string; data: IcsEvent }[]` signal maps: `baseEvents` signal `Map<string /*uid@cal*/, EventRecord>`, `overrides` signal `Map<string /*uid@cal#recId*/, EventRecord>`; `occurrences(range)` computed via expand (memoized per range+revision); CRUD actions: `createEvent(calUrl, ev)`, `updateEvent(record, patch, scope: 'all' | 'this' | 'future')`, `deleteEvent(record, scope)` — optimistic w/ rollback + toast on failure.
- `contacts.ts`: `contacts` signal `Map<string, { href; etag; data: Vcard }>` + CRUD like events.
- `toasts.ts`: `push(kind, msg)`.

`src/lib/sync/engine.ts`: `initSync()` (called from app mount): for each account → discovery → collections; per collection initial `syncCollection` (no token) then `getObjects` all; then `scheduler.ts` polls every 60s + on `visibilitychange` + after every local mutation re-syncs that collection; updates stores + `syncState` signal per account (`'ok' | 'syncing' | 'error'`). Accounts without a resolvable secret skip the network entirely (`{state:'error', message:'Password required'}` until unlocked); fetch-level failures surface as "Cannot reach the CalDAV server — check the URL and that the server/proxy is running." Window-range expansion happens in views, server sync is whole-collection (Radicale-correct, tiny payloads). Radicale error law (verified, see `local://wycal-research.md` §3): every request sends preemptive `Authorization: Basic` (bare 401 pops the browser's native dialog); invalid/expired sync token → **HTTP 403 with `D:valid-sync-token`** (NOT 409; tokens expire after 30 days) → drop stored token, rerun initial sync for that collection; stale `If-Match` on PUT → **412** → rollback optimistic state + toast + re-sync that collection; never blind-retry. Cache discovered principal/home-set URLs in `localStorage` keyed by account id, re-validate on 404.

## 5. FullCalendar wiring (views)

`CalendarView.tsx`: `<FullCalendar reactPlugin dayGridPlugin timeGridPlugin listPlugin multiMonthPlugin interactionPlugin>` with:
- **View streams**: header-less (our own header drives it). Named views: `dayGridMonth`, `timeGridWeek` (1wk), `timeGridTwoWeeks` (`duration: {weeks: 2}`), `timeGridDay`, `listAgenda`, `multiMonthYear` optional. Plus **N-days**: segmented control exposes `3` and `5` presets AND a stepper `N±` (1–14) mapping to dynamic view `timeGridNDays` via `visibleRange`/`duration` set at runtime (FullCalendar supports setting `duration` in view-specific options object — mutate through one `calendarOptions` signal). View state persists in hash query (`?view=week&date=2026-10-09&n=3`).
- Events: `events: (fetchInfo, success) => success(occurrences(fetchInfo.start, fetchInfo.end).map(toFcEvent))` reading store; `toFcEvent` sets `id: key`, `groupId: uid`, `backgroundColor/borderColor` from calendar color, `allDay`, `extendedProps: { record }`.
- Interactions: `select` (drag-create → editor prefilled), `eventDrop`/`eventResize` (optimistic move incl. all-day↔timed + duration preserve; `eventReceive` n/a), `eventClick` → editor, `dateClick` → create, `nowIndicator: true`, `slotDuration: '00:30:00'`, `slotLabelInterval: '01:00:00'`, `scrollTime: '07:00'`, `snapDuration: '00:15:00'`, `businessHours: { daysOfWeek: [1..5], startTime: '08:00', endTime: '18:00' }` subtle, `dayMaxEvents: true` + `eventMaxStack`, `expandRows`, `weekNumbers: false`, `firstDay` from prefs, `slotLabelFormat`/`eventTimeFormat` from `hour12` pref, `height: '100%'` flex fill, `allDayMaintainDuration: false`.
- Recurring edits: `eventDrop`/resize on an occurrence w/ rrule → editor asks scope (all/this/future); 'this' writes RECURRENCE-ID override, 'future' splits series (THISANDFUTURE approximated as: modify start of remaining via UNTIL on old + new RRULE from cut point — implement per `updateEvent` scope in stores; document simplification).
- Theme: `styles/theme.css` overrides the v6 runtime-injected styles purely via custom properties scoped `.fc { --fc-page-bg-color: var(--bg); --fc-border-color: var(--border); --fc-neutral-bg-color: var(--surface-2); --fc-neutral-text-color: var(--muted); --fc-today-bg-color: var(--accent-soft); --fc-now-indicator-color: var(--accent); --fc-highlight-color: var(--accent-soft); --fc-button-*` → surface tokens, `--fc-list-event-hover-bg-color: var(--surface-2)`, `--fc-more-link-*`, `--fc-daygrid-event-dot-width: 6px` `}` plus `.fc .fc-toolbar { display: none; }` (header-less) and lookless `.fc .fc-button` restyle. Full token list with defaults: `local://wycal-research.md` §1.4 (verified against 6.1.21). NO css imports from any `@fullcalendar/*` package (v6 has none).
- `MiniMonth.tsx`: own tiny dayGrid (not FullCalendar) 168px, dot markers for days with events (from occurrences of visible month), click → main view goto.

## 6. Routing & shell

`preact-router` hash mode. Routes: `#/` CalendarView (default), `#/contacts`, `#/settings`. Header nav buttons + `⌘/Ctrl+K`? (skip). Keyboard: `d/w/m/a` switch day/week/month/agenda, `t` today, `←/→`/`,`/`.` prev/next period (when not in inputs), `n` new event, `/` focuses search. Sidebar: New (primary), MiniMonth, calendar list w/ color dots + visibility checkboxes, "Contacts" + "Settings" links, account sync dots.

## 7. Event editor contract

Fields: title (required), calendar (select of visible), all-day checkbox, start/end (native `datetime-local`/`date`), location, notes, repeat select (None/Daily/Weekdays/Weekly/Monthly/Yearly/Custom{interval,byDay}), reminder select (None/At time/5m/10m/30m — VALARM). Delete (danger ghost) when editing. Save → store action with scope prompt when series. Validation: title non-empty, end > start (auto-fix: bump end=start+defaultDurationMin when start moved past end).

## 8. Testing

`bun test` for pure layers: ics parse/serialize round-trips (all-day, TZID, recurring, overrides, escaping/folding), recurrence expansion cases, vcard round-trip, caldav xml builders against fixture strings. No UI tests; smoke is manual/browser.

## 9. Radicale fixture contract (scripts/radicale/)

User `demo` / pass `demo`. Collections under `/demo/`: `personal.ics` (calendar, color #fa8d3e), `work.ics` (calendar, #55b4d4), `family.ics` (calendar, #a37acc), `contacts/` (addressbook). Seed: 12+ events incl. today-anchored (relative to run date: generate seed script computes dates around "now"), all-day, multi-day, overlapping, daily/weekly/monthly RRULEs, one TZID=America/New_York w/ VTIMEZONE, VALARM; 8 vcards. `scripts/radicale/start.sh` boots on 5232 w/ htpasswd; `scripts/seed.sh` idempotently MKCOLs + PUTs seed data.

## 10. Non-negotiables

Tokens over hex (design.md). No new deps without orchestrator approval. Subagents: do NOT run formatters, linters, builds, or tests — orchestrator runs all gates. TypeScript strict; no `any` in exported signatures. Files ≤ ~400 lines; split when over.

---

# Wave 2 contracts — org-agenda parity (appended law)

## §11 VTODO, tags, event colors (src/lib/ics)

- `IcsTodo` in types.ts: `{ uid: string; summary: string; description?: string; dtstart?: IcsDate; due?: IcsDate; status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED'; completed?: IcsDate; percentComplete?: number; priority?: 1|2|3|4|5|6|7|8|9; categories: string[]; relatedTo?: string /* parent todo uid */; color?: string; rrule?: string; exdates: IcsDate[]; alarms: { trigger: string }[]; raw?: string }`
- `IcsEvent` gains `categories: string[]` (CATEGORIES comma list, values text-unescaped). Both event+todo color round-trip via `X-WYCAL-COLOR:<hex>` (6-digit hex, no alpha) — parser reads → `.color`, serializer emits when set; unknown X- props still preserved in raw.
- `parseIcs(text)` return shape CHANGES to `{ events: IcsEvent[]; todos: IcsTodo[]; timezones: Map<string,string> }` — BEGIN:VTODO blocks parse into todos. Update all callers (stores/engine read `.todos` too).
- `serializeIcsTodo(todo, opts?): string` — mirrors serializeIcsEvent (VCALENDAR/VTODO, CRLF, folding, escaping, DTSTAMP/PRODID/UID, PRIORITY/STATUS/PERCENT-COMPLETE/COMPLETED/DUE/RELATED-TO/CATEGORIES/X-WYCAL-COLOR).
- `prioLetter(p?: number): 'A' | 'B' | 'C' | null` — 1–3→A, 4–6→B, 7–9→C, else null (org `[#A]` parity).

## §12 stores additions

- `src/stores/todos.ts`: `TodoRecord { key; calendarUrl; href; etag; data: IcsTodo }`; `todos` signal Map<uid@cal, TodoRecord> + `revision`; visibility follows the same calendar visibility set as events; CRUD `createTodo(calUrl, todo)`, `updateTodo(record, patch)`, `deleteTodo(record)` (optimistic + rollback + toast, same pattern as events); `toggleDone(record)` → STATUS NEEDS-ACTION↔COMPLETED + COMPLETED timestamp now↔none + PERCENT-COMPLETE 100↔undefined; `childrenOf(uid)` via relatedTo; computed `stuckTopLevel()` = incomplete todos with NO relatedTo, NO incomplete children, and no dtstart/due within the next 7 days (org stuck-projects approximation — definition is fixed law, do not reinterpret).
- `src/stores/caldefaults.ts`: `{ [calendarUrl]: { repeat?: string /* RRULE preset id */; durationMin?: number; reminder?: string; eventColor?: string } }` persisted `wycal.caldefaults`; `getCalDefaults(url)`, `setCalDefaults(url, patch)`.
- `src/stores/savedviews.ts`: `SavedView { id; name; sections: Array<{ type: 'agenda'; days: number; calendars?: string[] } | { type: 'todos'; filter: { status?: 'all' | 'open' | 'done' | 'stuck'; tag?: string; calendar?: string } } | { type: 'match'; query: string }> }` persisted `wycal.savedviews`; `savedViews` signal + `saveView/renameView/deleteView`.
- calendars.ts: `setCollectionColor(collection, hex)` — PROPPATCH `ICAL:calendar-color` via client, optimistic update + rollback.
- CaldavClient gains `proppatchColor(collectionUrl: string, hex: string): Promise<void>` (PROPPATCH, set calendar-color, Depth 0).

## §13 engine: provisioning + birthday materializer

- After listCollections per account, when `prefs.autoProvision !== false` (default true): if no calendar named `Inbox` → `mkcol` it (color `#39bae6`); if none named `Birthdays` → `mkcol` (color `#a37acc`). Then refresh the collection list once.
- `materializeBirthdays()` (engine, runs after contact-sync apply + on demand): for every contact with `bday`: ensure a VEVENT in the Birthdays calendar with uid `bday-${vcardUid}@wycal`: all-day DTSTART (bday year; `--MM-DD` partial → current year), `RRULE:FREQ=YEARLY`, `SUMMARY: ${fn}'s birthday`, `CATEGORIES: birthday`. PUT only when absent or changed. Remove the VEVENT when the contact or its bday disappears. Idempotent; no user-visible toasts on happy path.
- Sync routing: multiget responses containing BEGIN:VTODO go to todos store; VEVENT to events store (parseIcs gives both; apply per-object by which array contains the href).

## §14 palette (util/colors.ts + design.md §9)

`PALETTE: { name: string; hex: string }[24]` — the exact curated list in design.md §9 is law. Used by calendar color pickers, event color overrides, contact avatars (hash → index). `eventColorFor(record)` resolution order: event.color → caldefaults eventColor → calendar color.

## §15 views/routes

- New routes: `#/tasks` TasksView; `#/search` SearchMatchView (reads `?q=`); calendar route renders a saved composite when hash has `?saved=<id>` (sections stacked vertically, agenda section in list format).
- TasksView (org todo parity): toolbar = filter segmented (All / Not done / Done / Stuck), group-by select (Calendar / Tag / Priority / None), sort select (Priority / Due / Created), search input; quick-add input (top, autofocus via `N`): org syntax `text :tag1:tag2: #A d:2026-10-12` — tokens: trailing `:tag:` runs = categories, `#A|#B|#C` = priority (1/4/7), `d:YYYY-MM-DD` or `d:+Nd` = due, rest = summary; Enter → createTodo in the calendar select next to it (default: first visible VTODO-capable calendar). Rows: completion checkbox (toggleDone), `#A/B/C` badge (danger/warning/muted), title (strikethrough+dim when done), tag chips (click → filter), due date (overdue → --danger), calendar color dot, indent children under parent via relatedTo (one level), delete on hover.
- Agenda (listAgenda) appends todos whose due/dtstart falls in each day's range as `▢ title` rows after that day's events.
- SearchMatchView: big query input + hint row of chips; tokens `tag:x`, `cal:x`, `prio:A`, `due:Nd` (within N days), `done:true|false`, `free text`, `/regex/` match against summary+description+categories; evaluates over events AND todos; grouped results; `Save as view` → savedviews (prompt name via small inline input, no window.prompt).
- SavedView rendering: sections in order; agenda = day-grouped list (reuse SearchMatch/agenda row rendering), todos = TasksView row renderer with filter, match = search results for that query.

## §16 keybinds (labels everywhere)

Global: `N` New event · `Shift+N` New task · `C` New contact · `Shift+C` New calendar · `/` Search · `S` Settings · `X` Toggle sidebar · `?` Help · `1–9` toggle calendar n visibility · `Q`/`Esc` close dialog. Calendar: `D` Day · `W` Week · `Shift+W` 2 Weeks · `M` Month · `A` Agenda · `T` Tasks · `.` Today · `←/→` and `,/.` prev/next period · `+/-` N-days step. Dialogs: `Esc` cancel · `Cmd/Ctrl+Enter` save · `Cmd/Ctrl+Shift+Backspace` delete. Every shortcut appears (a) in the `?` Help overlay (grouped two-column table) and (b) as the button's `title` attribute, e.g. `title="New event (N)"`. Handlers: extend src/views/calendar/useShortcuts.ts AND add a global one in app.tsx (route-aware, input-gated — same gating rules as CONTRACTS §5).

Documented deviations (implementation law, see useShortcuts.ts): `.` is Today and `,` is previous-period ONLY (`,/.` above cannot double as "next"); `t` stays as a Today alias alongside `.` because `T`/`Shift+T` is Tasks.

## §17 editor changes

- Overflow fix: form is single-column; `datetime-local`/`date` inputs `width: 100%; min-width: 0`; modal body `max-height: 80vh; overflow-y: auto`; works at 320px.
- Color: swatch row (PALETTE + 'Use calendar color' reset) → `X-WYCAL-COLOR`; hidden when no calendar selected.
- Per-calendar defaults: on create (and when calendar changed while fields untouched): repeat/duration/reminder/eventColor prefilled from caldefaults; creating in Birthdays additionally defaults all-day + repeat Yearly.

## §18 sidebar changes

- Buttons: `+ New event` (was New) and `+ New calendar` (opens modal: name + PALETTE swatches → mkcol + refresh list).
- Per-calendar gear popover: PALETTE color row (setCollectionColor live), default repeat select / default duration / default reminder / default event color (caldefaults), 'Open tasks' link when VTODO-capable.
- Calendar rows show a tiny check icon (title 'Supports tasks') when components include VTODO.

## §19 radicale fixture + bootstrap

- users file gains `admin:admin` (bcrypt) beside `demo:demo`; `/admin/` collections seeded: Inbox (#39bae6), Birthdays (#a37acc), personal.ics (#fa8d3e), contacts/. Re-run seed script idempotently (add admin to its user list).
- `scripts/new-user.sh <user> <pass>` — appends bcrypt htpasswd entry via the venv python, then MKCOLs `<user>/Inbox/`, `<user>/Birthdays/`, `<user>/personal.ics/`, `<user>/contacts/`; idempotent; prints resulting URLs.
- App bootstrap: when `accounts.value.length === 0`, the calendar empty-state and Settings add-account form show a one-click `Connect local admin (admin/admin)` button → addAccount({ url: location.origin + '/dav', username: 'admin', password: 'admin', remember: false }) + sync.

## §14a todo editor (TasksView edit modal, org-agenda parity)

- Entry points (all call `openTodoEditor(record)` from `src/views/tasks/todoEditor.ts`, the editorState.ts-style request signal; TasksView mounts the single modal): §9.4-row pencil icon-btn (aria-label 'Edit task', title 'Edit task (E)', hover/focus reveal like the delete button, always visible ≤768px) · double-click on the row title · `E` with focus inside a row (document-level, gated by `isDialogOpen()` + `isEditableTarget()`; row found via its `data-todo-key`). The modal registers via `bumpDialogOpen` while open.
- Fields (single-column §9.6 form on `src/ui/Modal`, 480px): Summary (required, autofocus; empty → `aria-invalid` + 'Summary is required' helper, save blocked) · Notes textarea · Priority segmented None/#A/#B/#C (→ PRIORITY undefined/1/4/7) · Tags comma/space-separated input + removable `.tag-chip` list (CATEGORIES) · Due date input + optional Time checkbox → time input (all-day → `;VALUE=DATE`, timed → floating wall time) · Calendar read-only (updateTodo PUTs to the record's own href — no collection moves) · Completed checkbox (mirrors toggleDone: COMPLETED + COMPLETED stamp + PERCENT-COMPLETE 100 ↔ NEEDS-ACTION + cleared).
- Keybinds (§16 dialog law): `E` open editor from a focused row · `Cmd/Ctrl+Enter` save (title `Save (⌘⏎)`) · `Esc` cancel (Modal focus trap) · `Cmd/Ctrl+Shift+Backspace` confirm-free delete (title `Delete (⌘⇧⌫)`) via the same `deleteTodo` path as the row delete button.

## §21 editor when-inputs + 2-step delete confirm (wave 4)

- Event editor start/end: SEPARATE native `date` + `time` inputs (Google pattern; replaces the truncation-prone `datetime-local` — supersedes the §17 bullet naming `datetime-local`). When-rows stack full-width (`.editor-when`); All-day hides the time inputs, keeping a single date input per row. All-day ⇄ timed converts values once on toggle (no in-place input-type flipping); times hidden by All-day are preserved and resume when toggled back (fields that never had a time resume at 00:00). ICS semantics unchanged: `;VALUE=DATE` for all-day, DTEND exclusive +1 day rule, tzid/utcForm threading at save untouched.
- Delete confirm (supersedes the §14a 'confirm-free delete' wording): EventEditor Delete, TasksView row trash, and todo-editor Delete are 2-step — first click arms ('Sure?', danger styling, 3s revert timer), second click deletes, then the existing undo toast fires. `Cmd/Ctrl+Shift+Backspace` shares the steps: first press arms, second confirms; Esc or any other key disarms.
- Spacing pass toward comfortable (design.md §3 numbers updated to match): inputs `8px 12px`, list rows `6px 12px`; calendar toolbar gaps 10px; FullCalendar timegrid slots 1.7em, event pills `2px 4px 2px 5px`, dayGrid event margins 2px/4px (compact density restores FC's injected defaults). ScopeModal footer wraps (flex-wrap, gap 8px) so 'This and following' cannot push 'All events' off-card; Modal width stays `min(400px, calc(100vw - 32px))`.

## §20 font: Inter → Atkinson Hyperlegible (wave 4, user legibility request)

- UI font is now **Atkinson Hyperlegible** (`@fontsource/atkinson-hyperlegible`, static 400 + 700 imported in `src/main.tsx`). `--font-sans: 'Atkinson Hyperlegible', ui-sans-serif, system-ui, -apple-system, sans-serif` (theme.css). Supersedes design.md §2 "Inter Variable" (kept there as the superseded record); CONTRACTS §7 dep list updated and `@fontsource-variable/inter` dropped from package.json.
- Weights: family is static — 450 renders as 400, so labels that ran 450 under Inter use **500** (within design.md §2's 450–500 band); 700 stays period title + logo only.
- Tabular figures **verified present**: the shipped woff2's GSUB carries `tnum` (+`pnum`), so the existing body `font-variant-numeric: tabular-nums` (design.md §2 law) keeps aligning dates/times. No font-feature-settings fallback needed.
- No negative letter-spacing existed to relax; Atkinson is wider than Inter and nothing clipped.

## §21 agenda sticky header + density (wave 4, user "cramped"/overlap reports)

- List view sticky day headers: FC injects `.fc .fc-list-sticky .fc-list-day>*{background:var(--fc-page-bg-color);position:sticky;top:0}` with no z-index/separator — scrolled rows painted over it (transparent-overlap report). theme.css §10 override (self-repeated class): sticky cell gets `z-index:1; background:var(--surface); border-bottom:1px solid var(--border)`; the cushion keeps FC's solid `--fc-neutral-bg-color` (= --surface-2) band.
- Density: agenda rows `padding:10px 14px` (FC 8px); month dot rows `4px 0` (FC 2px); event-pill `.fc-event-main` padding `1px 6px` (FC 0; text clears the 3px calendar bar), dot events excluded; pill radius stays `--r-sm` per design.md §3.

## §22 calendar UX wave 5 (event popover, drill-down, zoom, motion, keybinds)

- §5 event interaction: a single click opens `EventDetailPopover` (`src/views/calendar/EventDetailPopover.tsx`) anchored to the clicked event element — viewport-clamped, max-width 340px, `.card` chrome. Content: title · formatted range (weekday+date · `start – end`; cross-day both ends; all-day date/date range, `All-day` badge, ↻ icon when RRULE) · calendar name + color dot (§14 `eventColorFor`) · location · description (4-line clamp) · CATEGORIES as `.tag-chip`s. Footer: `Edit` (primary → existing `openEditor` mode:'edit') · `Delete` (see below) · ghost `✕`. Esc and outside-click close; the popover registers via `bumpDialogOpen`/`bumpDialogClose` so global shortcuts are gated (§16).
- Delete flow: `requestDeleteEvent` dispatches `new CustomEvent('wycal:delete-event', { detail: { record }, cancelable: true })` on `window`; the listener MUST call `preventDefault()` when it consumes the delete. If the dispatch resolves unhandled (listener not yet wired), it falls back to `openEditor({ mode: 'edit', record })` so the button/key is never dead.
- §16 additions (Calendar scope, all present in the `?` overlay): `E` — event details of the selected event · `⌫`/`Delete` — delete flow on the selected event (no-op when none selected) · `Z` — run the most recent toast action (`runToastAction`, stores/toasts). Selection model: last-clicked event = outlined (inline `outline: var(--accent)`) with `data-wycal-key=<record.key>` on the element (eventDidMount); `E` re-finds the element via `[data-wycal-key]` (CSS.escape).
- Month drill-down: `navLinks: true`; `navLinkDayClick` → `switchView('day', date)` (timeGridDay + date; also fires for timeGrid day-header links); `navLinkWeekClick` → `'week'` (reachable only when weekNumbers renders; wired for parity). Day-number clicks never create events — FC swallows `dateClick` on nav links.
- N-days stepper fix: when the current day count matches no preset view (day=1 · 3d=3 · 5d=5 · week=7 · 2weeks=14), no preset segment is highlighted; a dynamic `{n} days` segment is appended and highlighted. Stepper reads `− N days +` so the unit is visible. Hash: an explicit `?n=` (1–14) is now authoritative on cold load even for 3d/5d; absent `?n=` still pins to the preset.
- Drag-select live tooltip: `selectAllow` (fires continuously while dragging) drives a fixed `.card` chip near the pointer (`pointer-events:none`, viewport-clamped) showing the forming range — timed `start – end` (§2 hour12 pref), cross-day with dates, all-day exclusive-end date range. A document-level `pointermove` listener is installed on the first `selectAllow` and removed on `select`/`unselect`/unmount.
- Time-axis zoom (timeGrid views only): toolbar `− / +` stepper titled "Zoom time axis" stepping Overview (`01:00`/`02:00`) · Comfortable (`00:30`/`01:00`, default) · Detailed (`00:15`/`00:30`) as `slotDuration`/`slotLabelInterval`. Prefs §4 gains ONE field: `zoom?: 'comfortable' | 'detailed' | 'overview'` (type `TimeZoom`, default `'comfortable'`, load-guarded). `snapDuration` stays `00:15`.
- View motion (`src/styles/view-transitions.css`): enter-only 150ms ease-out classes applied to the wycal stage `<div>` wrapping `<FullCalendar>` (never FC internals) — `.wycal-anim-prev`/`.wycal-anim-next` (slide-in ±16px for ‹ › / ← → / ,) and `.wycal-anim-view` (fade + scale .98→1 for view switches and Today); removed on `animationend` (+220ms belt; reflow restart on rapid repeats); `prefers-reduced-motion: reduce` disables all three. All navs funnel through `navigate(dir)` / `switchView(view, date?)`.
- Month `+N more`: verification only, no code change — FC's default popover is already themed by existing tokens (theme.css `--fc-more-link-*` on `.fc` + the `.fc .fc-popover.fc-popover` card override + `.wycal-ev .fc-event-main` pill chrome, which covers popover events).
- Stepper counter pills (wave 5, user: steppers read as prev/next): both toolbar steppers restyle as counter pills sitting right of the segmented control after a hairline divider — an `N days` pill and a `Zoom` pill, each with small inline `.btn-xs` −/+ INSIDE the pill (`− value +`; aria `Fewer days`/`More days`, `Zoom out time axis`/`Zoom in time axis`). Keybinds (§6/§16) and the `?n=` hash contract are unchanged.
- Time-axis zoom ladder (wave 5, supersedes the 3-preset model above): slots run `60 · 45 · 30 · 20 · 15 · 10 · 5` minutes, coarse → fine; `30`='Comfortable' (default), `15`='Detailed', `5`='Ultra'. Prefs §4 `zoom` becomes a NUMBER (minutes; load-guarded to 5–60; legacy `'overview'`/`'comfortable'` strings migrate to 30, `'detailed'` to 15). `slotLabelInterval` = `01:00:00` while slots ≥45min, else `00:30:00`; `snapDuration` stays `00:15`. ⌘/Ctrl+wheel over the grid zooms (wheel up = in/finer, down = out/coarser; `preventDefault` ONLY with the modifier held; ~120ms gesture gate; FC `slotDuration`/`slotLabelInterval` update live via `setOption`, prefs persist debounced 300ms) with a transient 800ms `N min slots` pill at the grid's top-right; the Zoom pill's −/+ steps the same ladder (immediate persist).
- Sidebar edge drag-resize (wave 5, user: control the shown width by dragging): a 6px `col-resize` handle (`touch-action: none`, ≥768px only, hidden when the aside is collapsed/mobile) mounts from CalendarView as a body-level fixed element positioned off `aside[aria-label="Calendar sidebar"]`'s rect (ResizeObserver-tracked) — Sidebar.tsx is untouched. Dragging writes `--sidebar-w` on `<html>` (clamped 200–420px; theme.css `:root` token 264px is the fallback) and persists prefs §4 `sidebarWidth` (number px, default 264, load-clamped, debounced 300ms); boot re-applies the stored width (inline var beats the token).
- Calendar comfort pass (wave 5, theme.css §24 block, self-repeated classes): all-day lane/cell frames min-height 28px; dayGrid bar pills (dot rows excluded) padding 3px 6px + min-height 24px; timeGrid pills padding 2px 6px; day numbers 1rem; col-header cushions 6px 8px. Agenda rows keep the §11 10px vertical.
- Agenda calendar names (wave 5): list-view rows (and agenda todo rows) append the calendar's sidebar display name to the title as ` (Name)` — applied in `useCalendarEvents` after search filtering (search still matches the bare summary); all other views keep the bare summary.

## §23 saved views V2 + sidebar order + mini agenda (wave 4)

- Saved views V2 (store `src/stores/savedviews.ts`): `{ id; name; keybind?; visibility: string[] /* visible calendar URLs */; view: 'day'|'3d'|'5d'|'week'|'2week'|'month'|'agenda'|'ndays'; n?; includeTodos }`, persisted `wycal.savedviews2` (array of views). §12 V1 composites stay on `wycal.savedviews`, untouched. `saveCurrentView(name?)` captures the live visible-calendar set + current hash view/n + todos toggle (view==='agenda'), never the date; `applyView(id)` restores visibility (`calendars.setVisibility`) then navigates `#/?view=<name>&n=<differs-from-preset>&date=<today>` ('ndays' renders as the 3d-preset timeGrid with `n`); `renameViewV2`, `setViewKeybind`, `deleteViewV2`.
- Keybinds (§16 sub-law): a V2 view may bind ONE printable key, dispatched by Sidebar's own document keydown listener gated by `isDialogOpen`/`isEditableTarget` (registered before app.tsx/useShortcuts — capture path uses stopImmediatePropagation). Reserved: §16 globals (both letter cases), period/step punctuation (`,.?/+ -`), digits 1–9, and any other V2 view's key — `keybindConflict(key, selfId)` in the store; conflicts flash the row's key pill red and keep capture armed; Esc cancels.
- Sidebar (design.md §4 amendment): top row keeps only `+ New event`; `+ New calendar` is a ghost button under the Calendars list. Below the calendar nav: mini agenda (`MiniAgenda.tsx`, "Upcoming") = next 14 days of `occurrences()` + open todos, rows `Mon 13 · 09:30 Title` / `· All-day`, todos rendered `▢ Title`, Today header first, ~200px scroll, row click → `gotoCalendarQuery({ date })`, §5 skeletons during initial sync, empty → "Nothing coming up". Saved views section: V2 rows (name + calendar-count chip + key pill; hover: rename / keybind / delete) above the §15 V1 composites (unchanged); `+` in the section header saves the current view (inline name input).

## §24 first-run sign-in gate (wave 5, user "normal simple sign in page")

- Gate (`src/app.tsx`): when `accounts.value.length === 0`, App returns `<SignIn />` INSTEAD of the whole calendar shell (sidebar/header/routes/toasts) — first-run only. Any existing account (even locked or sync-errored) keeps the shell; profiles with accounts never see the card. Exception: the module signal `signInActive` (`src/views/auth/SignIn.tsx`) holds the card up while its submit is in flight or showing its error — otherwise the gate would unmount the card the instant `addAccount` lands and the inline error could never render. It clears on sync 'ok', on the 8s timeout, and on any reload (a reload with the errored account lands in the shell, whose own empty state surfaces the sync error per §19).
- Card (`src/views/auth/SignIn.tsx`): centered `.card` (max-width 360px) on the app background; title `wycal`, subtitle "Sign in to your CalDAV server"; fields Server URL (prefilled `${location.origin}/dav`, editable), Username (autofocus), Password; checkbox "Remember password" (unchecked, muted hint "Stored in plain text on this device"). Primary "Sign in" is disabled until username+password are non-empty; it's a real `<form>` submit (Enter works). No auto-submit, no signup, no forgot-password.
- Submit flow: `addAccount({url, username, password, rememberPassword})` → `initSync()` (idempotent) → the shell appears as the initial sync runs. SignIn watches the new account's `syncState` for ~8s: `error` → inline red helper `Could not sign in — check server, username and password` (`aria-live="polite"`), form re-enabled, and a resubmit first `removeAccount`s the errored attempt so retries never stack duplicate rows; `ok` or timeout → card clears, shell renders. Demo/admin quick buttons ("Use the local demo account (demo/demo)", "Connect local admin") prefill and funnel through the same submit; the latter mirrors CalendarView `connectAdmin` (§19). While the card is up it swallows body-targeted keydowns at capture (field typing untouched) so §16 globals can't queue actions behind it.


## §25 Sidebar element sizing + mini-month comfort (wave 6)

- Sidebar width: drag the right edge (6px handle, 200–420px, `prefs.sidebarWidth`, §22).
- Element scale: compact/default/large presets (`prefs.sidebarSize`, stamped on `<html data-sidebar-size>`) — footer control is a labeled `Size` group of three square calendar-glyph buttons (aria `Sidebar size: <preset>`); Settings → Appearance has the same segmented.
- Mini-month (`src/views/shell/MiniMonth.tsx`, CSS in app.css EOF block): default 34px cells (accent-filled circular today, ring on selected, uppercase weekday header), compact 26px, large 40px; header row `1rem` semibold with ≥32px nav hit targets; header tooltip 'Drag the sidebar edge to resize'. Fixed cell grids: 238/182/280px — below ~262px sidebar width the default grid clips (aside overflow-hidden), compact fits to ~206px.

## §26 Mobile UI (wave 6, <768px only)

- Top bar collapses to ONE row: [title truncate text-sm font-semibold][spacer][Today]; ‹ ›, segmented control, days pill, zoom pill are `max-md:hidden`. Desktop ≥768px is byte-identical to §22 layout.
- Bottom bar (calendar view only, `.wycal-mobile-bar`, md:hidden): fixed, 56px + safe-area, 5 equal slots [‹][Today][FAB][View][›]. FAB = 48px round accent 'New event' → `requestNewEvent` (same create path as the sidebar New event). 'View' opens the view sheet (role=dialog): 7 view options + days −/+ (n-day views) and zoom −/+ (timeGrid) reusing the toolbar steppers; dismiss = outside pointerdown / Esc / selection; while open, §16 globals are gated via bumpDialogOpen. Stage wrapper gets 64px bottom padding on mobile so the bar never covers the last grid row.
- The bar's CSS is unlayered with base `display:none` ≥768px (Tailwind `md:hidden` alone loses to unlayered rules).

## §27 Tasks navigation + org-super-agenda view; unified detail popovers (wave 7)

- Tasks nav: sidebar footer link (checkbox-glyph tile + 'Tasks') → #/tasks, aria-current when active — parity with the Header Contacts button.
- TasksView tabs (sessionStorage `wycal.tasks.tab`): Today (due ≤ today incl. overdue), Upcoming (7d), Overdue, All. Structure: day header ('Today · Sun Oct 11' / 'EEE MMM d' / danger 'Overdue' / 'No date') → calendar subgroups ([color dot] Name (n) — org-super-agenda style) → rows. Row: #A/#B/#C priority pill (IS the cycler 1→5→9), checkbox (toggleDone), summary (strike when done), due chip (danger when overdue, accent when today), tag chips, hover actions +1d / edit pencil / 2-step delete. Quick-add + E/dlbclick editor + Shift+N focus intact.
- Todos on the calendar grid: feed emits all-day EventInputs `todo:<key>` (title '▢ summary', extendedProps.todo) for visible todos with DUE/DTSTART in range — click opens TodoDetailPopover (NOT the #tasks redirect).
- TodoDetailPopover / ContactDetailPopover mirror EventDetailPopover: anchor + Esc/outside close + dialog gate + 2-step Sure? delete. Todo quick actions: cycle status (NEEDS-ACTION→IN-PROCESS→COMPLETED), cycle priority, Due +1d (stores: cycleTodoStatus/setTodoPriority/setTodoDue over updateTodo semantics). Contact: single click = popover, dblclick = editor; avatar helpers live in ContactDetailPopover.tsx.
- Removed: todo editor's Calendar display field (calendar-move UI) and the todo-click → #tasks hash redirect. Store refile capability unchanged.
- All-day span law: toFcEvent's ≥24h allDay-display round-up applies ONLY to timed events (`!rec.data.allDay`); all-day DTEND is already an exclusive midnight and passes through — 1-day events render 1 day.

## §28 Todo mutation serialization + Todoist UX (wave 8)

- stores/todos.ts: updateTodo/deleteTodo chain per todo key (`todoMutations` Map → sanitized tails). Each queued mutation re-resolves the live record at run time (fresh etag) and merges the caller patch; failures roll back ONLY when `isTail()` (no newer mutation queued) — superseded failures just requestSync. Rapid quick-action clicks are structurally race-free: no revert flashes, final state = last click, server matches.
- Quick-add NL parser (src/views/tasks/quickAdd.ts, pure): today/tomorrow/weekday/next-weekday/in-Nd/calendar-date/M-D/at-HH[:MM][ampm]/HH:MM; #A-#C + !p1-p3 → 1/5/9; +tag → tags; matched tokens stripped from summary; unmatched text flows through the org parser (:tag:, d:…) unchanged. Live hint under the input (role=status): '→ Fri Oct 16 · 5:00pm · #A · +home'.
- Drag-to-reschedule: todo chips on the calendar drag (FC eventDrop) → setTodoDue with time-of-day + form-class preserved; failure reverts; success toasts 'Task moved to <date>' with Undo → setTodoDue back. eventResize on todos = revert (no duration).
- Inline rename: dblclick on a TasksView summary → inline input (Enter/blur commit, Esc/empty cancel); row-background dblclick still opens the editor.
