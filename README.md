# wycal

A fast, pretty CalDAV + CardDAV web client for [Radicale](https://radicale.org/) — no backend of our own. Preact + Bun + Vite + TypeScript, styled on the Ayu theme (light/dark/auto), calendar rendering by FullCalendar v6.

## Quickstart

```sh
bun install

# One-time: local Radicale fixture (start.sh expects this venv)
python3 -m venv scripts/radicale/.venv
scripts/radicale/.venv/bin/pip install radicale bcrypt

./scripts/radicale/start.sh   # Radicale on 127.0.0.1:5232
./scripts/seed.sh             # seed demo + admin accounts (idempotent)
./scripts/seed-demo.sh        # rich demo/demo fixture (see Demo data)
bun run dev                   # Vite on http://localhost:5173
```

Open <http://localhost:5173> and either click **Connect local admin (admin/admin)** or add an account with `demo` / `demo`. Two fixture users are provisioned by the seed script:

- `admin` / `admin` — Inbox (events + tasks), Birthdays, personal calendar, contacts (with a BDAY contact exercising the birthday materializer)
- `demo` / `demo` — 17 events across personal / work / family calendars, 18 tasks in Inbox, and 12 contacts (see [Demo data](#demo-data))

## Features

| Area | What you get |
| --- | --- |
| Views | Day / 3d / 5d / week / 2-week / month / agenda, plus an N-days stepper (1–14) that appends a dynamic `{n} days` segment when the count matches no preset. View + date persist in the hash query. |
| Month drill-down | Click a month-view day number to jump into that day. |
| Time-axis zoom | Toolbar `−`/`+` (or ⌘/Ctrl+wheel over the grid) steps the timeGrid slot size through 30 · 20 · 15 · 10 · 5 minutes. |
| Sidebar | `X` toggles it; drag the right edge to resize; compact / default / large size presets (the `A A A` footer); 168px mini-month with occurrence dots + month/year picker; "Upcoming" mini-agenda lists the next 14 days of events + open tasks (click a row to jump to that day). |
| Mobile | Under 768px the sidebar becomes an off-canvas drawer, dialogs become bottom sheets, and a bottom navigation bar + floating action button (FAB) carry view switching and quick create. |
| Sign-in | With no accounts yet, a sign-in card stands in for the whole shell (server URL + user + password, "Connect local admin" helper). Secrets stay in sessionStorage unless you tick Remember. |
| Tasks (`#/tasks`) | Org-agenda-style VTODO view: status filter (All / Not done / Done / Stuck), group by calendar / tag / priority, sort by priority / due / created, `#A`/`#B`/`#C` priority letters (PRIORITY 1–3 / 4–6 / 7–9), red overdue dates, done toggling, and a quick-add line with org syntax: `Feed the cat :home: #A d:+1w` — `:tag:` → CATEGORIES, `#A`–`#C` → priority, `d:YYYY-MM-DD` (or `d:+Nd`/`+Nw`/`+Nm`) → DUE. |
| Scheduled todos | VTODO `DTSTART` reads as org-agenda "scheduled": a task appears from its scheduled date even with no DUE, while DUE drives the due column. |
| Agenda inline todos | Open VTODOs render inline in the agenda list view (per-calendar VTODO toggle) and in the sidebar Upcoming mini-agenda. |
| Event popover | A single click opens a detail card (full range, calendar, location, description, tags) with Edit / Delete. The last-clicked event stays selected: `E` details · `⌫` delete · `Z` undo. |
| Recurring events | RRULE series with per-instance overrides; series edits offer a scope: this one / all / future. |
| Tags & colors | CATEGORIES on events and tasks; per-event color overrides and per-calendar colors (PROPPATCH `ICAL:calendar-color`) from a curated 24-color palette. |
| Per-calendar defaults | New-event prefill per calendar: repeat preset, duration, reminder, color. |
| CardDAV birthdays | Contacts with a BDAY (incl. the reduced `--MM-DD` form) auto-materialize as yearly all-day events in a per-account Birthdays calendar, written on the first sync after connecting. |
| Contacts (`#/contacts`) | CardDAV address book: list + detail panel + full editor (name, ORG/ROLE, multi-type emails, phones, URL, BDAY, PHOTO, NOTE); `C` creates a contact. |
| Saved views | The sidebar's `+` captures calendar visibility + view + N-days range + tasks toggle (never the date). Rows rename, delete, and bind one custom key each (conflicts flash red); clicking a row restores the setup. Older composites stay shareable via `#/view/:id`. |
| Scratch notes | `\` toggles a local-only scratchpad, autosaved to `localStorage` 400ms after your last keystroke — never synced. |
| Search | `/` (or the header box) with tokens `tag:` `cal:` `prio:A|B|C` `due:Nd` `done:true|false` and `/regex/`; grouped results with "Save as view". |
| Safe deletes | Every delete is 2-step (arm "Sure?" → confirm) and followed by an undo toast; `Z` replays the most recent toast action. |
| Look & feel | Ayu theme (light / dark / auto), compact / cozy density, Atkinson Hyperlegible type, view-change motion (disabled under `prefers-reduced-motion`). |
| Keyboard | Everything is reachable from the keys — `?` shows the live cheatsheet, mirrored below. |

## Keyboard shortcuts

| Scope | Keys | Action |
| --- | --- | --- |
| Global | `N` | New event |
| | `Shift+N` | New task |
| | `C` | New contact |
| | `Shift+C` | New calendar |
| | `/` | Search |
| | `S` | Settings |
| | `X` | Toggle sidebar |
| | `\` | Scratch notes |
| | `?` | Help |
| | `1`–`9` | Show/hide calendar 1–9 |
| | `Q` / `Esc` | Close dialog |
| Calendar | `D` | Day view |
| | `W` | Week view |
| | `Shift+W` | 2-week view |
| | `M` | Month view |
| | `A` | Agenda view |
| | `T` | Tasks |
| | `.` / `t` | Today |
| | `←` / `→` | Previous / next period |
| | `,` | Previous period |
| | `+` / `-` | Step N-days |
| | `E` | Event details (selected) |
| | `⌫` / `⌦` | Delete selected event |
| | `Z` | Undo (toast action) |
| Tasks | `Shift+N` | New task (quick-add) |
| | `Enter` | Quick-add create |
| Dialogs | `Esc` | Cancel / close |
| | `⌘/Ctrl+Enter` | Save |
| | `⌘/Ctrl+Shift+⌫` | Delete |

## Demo data

`./scripts/seed-demo.sh` upgrades the `demo` / `demo` account from `seed.sh`'s minimal fixture to a rich one (the `admin` account is never touched):

- 17 events across Personal (10) / Work (4) / Family (3): recurring series with a per-instance override, multi-day and cross-midnight spans, all-day days, TZID and floating times, color overrides, tags, STATUS/URL fields, and folded descriptions.
- 18 tasks in Inbox (`t401`–`t418`): `#A`/`#B`/`#C` priorities, an overdue item (Oct 1), one due today, one due this week, DTSTART-scheduled ones, in-process at 40%, completed, two-tag CATEGORIES (`deep-work` / `home` / `errand`, …), org-style `Next:` action lines in notes, and a far-future due (Mar 2027).
- 12 contacts: 7 with a BDAY — including the reduced `--06-15` form and birthdays landing **Oct 14** and **Oct 29** — plus a rich no-BDAY record (PHOTO, ORG, ROLE, 3 emails, 2 phones).

Items are PUT to stable hrefs (one resource per UID), so re-running overwrites in place; the sweep only removes the old `seed-*` fixture, never your data. Dates are pinned to the Oct–Dec 2026 window. The Birthdays calendar starts empty — birthday events materialize into it on the first sync after you connect.

### What to click (demo/demo)

| To see | Do this |
| --- | --- |
| Sign-in page | Open the app with no saved accounts (fresh browser profile): the sign-in card replaces the whole shell. Sign in as `demo` / `demo`. |
| Tasks view | Press `T`: "Submit expense report" red/overdue, "Draft Q4 planning doc" at 40%, "File tax paperwork" under the Done filter. Set Group by → Tag to see the `deep-work` / `home` / `errand` groups. |
| Scheduled todos | Same view: "Deep-clean the kitchen" and "Review PR #482" are DTSTART-scheduled with no DUE. |
| Task quick-add | In the Tasks toolbar input type `Water the plants :home: #C d:+2d` and press Enter. |
| Agenda inline todos | Press `A`: open Inbox tasks interleave with events; toggle a calendar's VTODO check mark in the sidebar to include/exclude them. |
| Upcoming mini-agenda | Sidebar "Upcoming": next 14 days incl. open tasks; click a row to jump to that day. |
| Mini-month | Sidebar top grid: occurrence dots, click a date, month/year dropdown. |
| Sidebar resize + presets | Drag the sidebar's right edge; click the `A A A` footer presets (compact / default / large). |
| Birthday materialization | After connecting, the Birthdays calendar fills on first sync: Ivy Zhang (Wed Oct 14), Kevin Fong (Oct 29), Luna Mak every Jun 15 (`--06-15`). |
| Contacts editor | `#/contacts` → click a contact → Edit: emails, phones, ORG/ROLE, NOTE, PHOTO round-trip; `C` creates a new one. |
| Event popover | Click any event → detail card with description + tags; `E` re-opens it for the selected event. |
| 2-step delete + undo | Select an event, `⌫` → "Sure?" → confirm → undo toast; `Z` puts it back. |
| Recurring edit scopes | Click a "Morning swim" occurrence → Edit → change the time → Save → choose this one / all / future. |
| Time-axis zoom | Day or week view → ⌘/Ctrl+wheel over the grid (or toolbar `−`/`+`): slots step 30 → 5 min. |
| N-days stepper | Toolbar `+`/`-` past 5d → the dynamic `{n} days` segment. |
| Month drill-down | `M`, then click a day number → day view. |
| Saved views + keybinds | Arrange calendars, press `+` in Saved views, name it, bind a single key (conflicts flash red); press that key to restore. |
| Search | `/`, try `tag:deep-work`, `prio:A`, `due:7d`, `/ryokan/` → grouped results + "Save as view". |
| Scratch notes | Press `\`, type, wait a beat, reload — it persists locally only. |
| Theme + density | `S` → Appearance: Ayu light/dark/auto, compact/cozy. |
| Keybind cheatsheet | Press `?`. |
| Mobile bar + FAB | Narrow the window below 768px: off-canvas sidebar drawer, bottom navigation bar + FAB for quick create. |

## Managing users

```sh
scripts/new-user.sh alice s3cret
```

Writes a bcrypt entry into `scripts/radicale/users` (re-running rotates the password) and idempotently provisions the user's collections: `/<user>/`, `Inbox/`, `Birthdays/`, `personal.ics/`, `contacts/`. The Radicale fixture must be running; rights are `owner_only`, so each user only ever sees their own collections.

## Org-mode users

Export an agenda from Org with `org-icalendar` and PUT the resulting `.ics` straight into a Radicale collection:

```sh
curl -sS -u demo:demo -H 'Content-Type: text/calendar; charset=utf-8' --data-binary @agenda.ics -X PUT http://127.0.0.1:5232/demo/personal.ics/org-agenda.ics
```

(Running through the dev server instead? Use `http://localhost:5173/dav/demo/personal.ics/…` — the Vite proxy strips the `/dav` prefix.) Org tags become CATEGORIES (searchable with `tag:`), and Org TODOs become VTODOs whose PRIORITY 1–9 wycal displays as `#A` (1–3), `#B` (4–6), `#C` (7–9).

## Architecture

- `src/lib/` — the pure layers: `ics/` (parse/serialize/recurrence expansion, timezone handling), `caldav/` (client, XML builders), `vcard/` (vCard 4.0), `sync/` (engine + poll scheduler).
- `src/stores/` — `@preact/signals` state (accounts, calendars, events, todos, contacts, prefs, saved views, calendar defaults).
- `src/views/` — FullCalendar host + toolbar, tasks, contacts, search, settings, shell.
- All DAV traffic goes through the same-origin Vite proxy: `/dav` → `http://127.0.0.1:5232` (Radicale stays prefix-free). Syncs use sync-collection REPORT with sync-token deltas — only changed hrefs are re-fetched; an invalid/expired token falls back to a full resync.
- Local mutations are optimistic with rollback + toast on failure.

## Dev

```sh
bun run dev     # dev server on :5173 (proxies /dav)
bun run build   # tsc -b && vite build
bun run test    # bun test (pure layers: ics, recurrence, vcard, caldav xml)
bun run preview # built app on :4173 (also proxies /dav)
```

`scripts/verify-dav.sh` boots a fresh Radicale, seeds it, and curl-verifies PROPFIND / sync-collection / calendar-query REPORTs plus seed idempotency. The fixture (config, users, seed data) lives under `scripts/radicale/`.
