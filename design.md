# wycal design.md — Ayu light/dark design system

Single source of truth for all UI. Every component MUST use these tokens (via Tailwind utility classes or `var(--token)`), NEVER raw hex values. Density: information-dense like Google/Apple Calendar, calm like Ayu.

## 1. Color

Ayu palettes. `:root` = light, `[data-theme="dark"]` = dark, `[data-theme="auto"]` resolves via `prefers-color-scheme`. Set `data-theme` on `<html>` from `prefs.theme` store.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#fafafa` | `#0b0e14` | app background |
| `--surface` | `#ffffff` | `#131721` | cards, modals, popovers, sidebar |
| `--surface-2` | `#f2f3f4` | `#1d222c` | hover rows, input fills, raised wells |
| `--surface-3` | `#e8eaec` | `#272d38` | active/pressed, chips |
| `--border` | `#e2e4e7` | `#262b36` | hairlines (1px), grid lines |
| `--border-strong` | `#c9cdd1` | `#3a4150` | inputs, dividers |
| `--fg` | `#5c6166` | `#bfbdb6` | primary text |
| `--fg-strong` | `#21252b` | `#e6e1cf` | headings, emphasized |
| `--muted` | `#8a9199` | `#6c7380` | secondary text, placeholders |
| `--accent` | `#fa8d3e` | `#ff8f40` | primary actions, focus, selection |
| `--accent-fg` | `#ffffff` | `#0b0e14` | text on accent |
| `--accent-soft` | `#fa8d3e26` | `#ff8f4026` | soft fills, today ring |
| `--danger` | `#f07178` | `#f07178` | destructive |
| `--danger-soft` | `#f0717826` | `#f0717826` | destructive fills |
| `--success` | `#86b300` | `#aad94c` | confirmations, sync-ok |
| `--warning` | `#fa8d3e` | `#ffcc66` | sync errors/retry |
| `--overlay` | `#5c616633` | `#05070a99` | modal scrim |
| `--focus-ring` | `#55b4d4` | `#39bae6` | keyboard focus outline |

Event palette (calendar colors, auto-assigned round-robin; derived from Ayu syntax colors). Each has solid + `-soft` variant (hex + `26` alpha):

`--ev-blue #55b4d4 / #39bae6`, `--ev-green #86b300 / #aad94c`, `--ev-red #f07178 / #f07178`, `--ev-purple #a37acc / #d2a6ff`, `--ev-yellow #cca700 / #e6b67d`, `--ev-cyan #4cc2b4 / #95e6cb`, `--ev-orange #fa8d3e / #ff8f40`, `--ev-pink #d597c0 / #f28779`.

All-day/event pills: `background: <color>-soft`, `border-left: 3px solid <color>`, `color: <color>` in dark; in light use `color: darken-ish fg-strong` — simply use the solid color for text on light, soft bg both. Timed events: 3px left bar in solid color, text `--fg-strong`. `color-scheme: light dark` set on root.

Contrast: text tokens on their surfaces ≥ 4.5:1. Never place `--muted` on `--surface-3`.

## 2. Typography

- Font: **Inter Variable** (`@fontsource-variable/inter`, weights 100–900, normal + italic). Fallback stack: `Inter Variable", Inter, -apple-system, "Segoe UI", sans-serif`. Mono (URLs, UIDs, etags in settings): `ui-monospace, "SF Mono", monospace`.
- Scale (tight, dense): `--text-xs 11px` (time labels, chips), `--text-sm 12.5px` (grid events, meta), `--text-base 13.5px` (body), `--text-md 15px` (section titles), `--text-lg 18px` (page/modal titles), `--text-xl 22px` (period title in header). Line-height 1.45 body; 1.2 for headings/tight labels.
- **All dates/times/durations use `font-variant-numeric: tabular-nums`** so grids align.
- Weight: 400 body, 450–500 labels/emphasis, 600 headings, 700 only period title + logo.

## 3. Space, shape, elevation

- Spacing scale (px): 2 4 6 8 12 16 20 24 32. Dense paddings: inputs `8px 12px`, list rows `6px 12px`, modal `20px`.
- Radii: `--r-sm 4px` (chips, checkboxes), `--r 6px` (inputs, buttons), `--r-lg 10px` (cards, modals), `--r-full 999px` (pills, avatars). Time-grid event pills `--r-sm`.
- Elevation: `--shadow-1` popover `0 1px 2px rgba(0,0,0,.08)`; `--shadow-2` modal `0 8px 28px rgba(0,0,0,.18)` (+ scrim). Dark: increase alpha. Hairlines 1px `--border`, no borders + shadows stacking unless floating.
- Icons: inline SVG, 16px controls / 14px inline, `stroke="currentColor"`, `stroke-width 1.75`, from Lucide paths copied as a tiny `src/ui/icons.tsx` map (no runtime icon lib).

## 4. Layout

Desktop (≥1024px): fixed left sidebar `264px` (`--surface`, right hairline), header `48px` (`--bg`/blur, bottom hairline), main fills rest. Sidebar order: logo + New button, mini-month, calendar list, contacts link, account status. Header (global chrome only): menu (mobile) / wycal wordmark (600) / spacer / search box (240px, filters agenda) / theme toggle / contacts icon-link / settings gear. The calendar view owns a second toolbar row directly above its grid: `Today` / ‹ › / period title (`--text-xl`, tabular) / spacer / view switcher (segmented: Day · 3d · 5d · Week · 2 Weeks · Month · Agenda) / N-days stepper (`– N +`, 1–14, visible while an N-day preset is active).
Mobile (<768px): sidebar becomes off-canvas drawer (scrim, 280px, swipe/hamburger); header wraps to two rows — row 1 nav + title, row 2 horizontally scrollable segmented view switcher; bottom-safe padding. Breakpoints: `sm 640, md 768, lg 1024` (Tailwind defaults).

FullCalendar containers get `--fc-*` mapped onto these tokens (see CONTRACTS §5).

## 5. Components

- **Buttons**: default = `--surface` fill, `--border` 1px, `--fg` text, hover `--surface-2`, active `--surface-3`; primary = `--accent` fill `--accent-fg` text hover brightness(1.05); ghost = transparent hover `--surface-2`; danger = `--danger`. Height 28px (sm 24px). Focus-visible: 2px `--focus-ring` outline offset 1px.
- **Inputs**: `--surface` (dark: `--surface-2`) fill, 1px `--border-strong`, radius `--r`, focus ring as above. Labels `--text-xs --muted` 500 above, 4px gap. Invalid: `--danger` border + helper.
- **Segmented control** (view switcher): `--surface-2` track, active segment `--surface` + `--shadow-1` + `--fg-strong`; `--text-sm`.
- **Modal**: centered 480px (`--r-lg`, `--surface`, `--shadow-2`, scrim `--overlay`), mobile: bottom-sheet full-width. Header 15px 600, body rows 8px gap, footer right-aligned buttons (Cancel ghost / Save primary).
- **Event editor**: fields per CONTRACTS §7. All-day toggle swaps datetime → date inputs. Recurrence select: None / Daily / Weekdays / Weekly / Monthly / Yearly / Custom (interval + byday picker shown inline).
- **Chips**: calendar color dot 8px `--r-full` + name `--text-sm`; checkbox toggles inclusion.
- **Cards (contacts)**: `--surface`, `--r-lg`, hairline; avatar = initials on `<color>-soft` bg with solid-color text, 40px circle; name `--fg-strong` 500, meta `--muted` `--text-sm`; grid `auto-fill minmax(240px,1fr)`, 12px gap.
- **Empty states**: centered `--muted` icon 24px + one line + optional primary action; NEVER blank panes.
- **Loading**: skeletons (pulse, `--surface-2` blocks) for sidebar lists and first calendar paint; inline `--warning` dot + "Syncing…" in account row during network ops. Toasts: bottom-right stack, `--surface`, `--shadow-1`, 3.5s auto-dismiss, kinds info/success(`--success` dot)/error(`--danger` dot).
- **Current time indicator**: 1.5px `--accent` line + 8px dot on the time label column.

## 6. Motion & interaction

150ms `ease-out` for hover/press/expand; 200ms for drawer/modal (scale .98→1 + fade). `prefers-reduced-motion: reduce` → durations 0. Drag affordances: cursors `pointer`/`grab`/`col-resize` where draggable. Hit targets ≥ 28px desktop, ≥ 40px mobile.

## 7. Accessibility

Focus trap in modals/drawers, `Esc` closes, restore focus on close. All icon-only buttons: `aria-label`. Time grid and month grid rely on FullCalendar a11y; custom controls must be keyboard reachable. Color never the only signal (event pills also have text; sync states have text).

## 8. Do / Don't

DO: tokens only; tabular nums everywhere numeric; hairlines over shadows for static chrome; one accent color doing the talking; density via small paddings not small fonts.
DON'T: raw hex in components; second shadow language; emoji as UI icons; full-page spinners; new font stacks; gradient decoration.

## 9. Wave-2 additions

### 9.1 Grid highlights are SQUARES

All calendar-grid day highlights (mini-month today/selected, month-view today number chip, week-view date chips) use squares: radius `2px` max, no circles anywhere in grids. Mini-month today = filled square `--accent`/`--accent-fg`; selected = 1.5px `--accent` outline square; today+selected = filled + inner ring. Month-view today number: square chip (`--accent-soft` bg, `--accent` text, radius 2px), not a round bubble.

### 9.2 Month/year dropdown navigation

In month view (and always in the mini-month header) the period label splits into two dropdown buttons: month name and 4-digit year (tabular). Buttons look like ghost buttons (design.md §5); open a small popover list (12 months / year range current±10, `--surface`, `--shadow-1`, radius `--r`, max-height 240px scroll); selecting navigates. Popover closes on outside click/Esc.

### 9.3 Curated palette (24, law for pickers)

Both-theme-safe (mid lightness ~55–70%, moderated chroma; pairs with soft tints at 16% alpha like event pills). Names are stable ids.

`red #e05661` · `coral #f07178` · `salmon #f28779` · `orange #fa8d3e` · `amber #e6b67d` · `sand #cca700` · `olive #98971a` · `lime #86b300` · `grass #7fb454` · `mint #4cc2b4` · `teal #95e6cb` · `sky #55b4d4` · `azure #39bae6` · `cobalt #5b8fdf` · `periwinkle #6c9ef8` · `iris #a37acc` · `lilac #b888e2` · `violet #d2a6ff` · `orchid #d597c0` · `rose #e0879e` · `slate #8a9199` · `graphite #6c7380` · `moss #7a9e7e` · `pine #3f8f6f`

Swatch rows: 24 chips, 20px squares (radius `--r-sm`), selected = 2px `--focus-ring` ring + check glyph (accent-fg), 'none/calendar-default' slot for event color uses `--border-strong` diagonal slash chip.

### 9.4 Tasks view rows

Row height 32px, checkbox 16px (`--r-sm` square), `#A` badge text-xs 600 in `--danger`, `#B` `--warning`, `#C` `--muted`; tag chips 4px 8px `--surface-3` radius `--r-full` text-xs; due text-xs tabular (`--danger` when overdue, `--muted` otherwise); done rows: title line-through `--muted`. Quick-add input spans full width with `+` glyph and syntax hint placeholder `Feed the cat :home: #A d:+1w`. Section headers text-xs 600 uppercase tracking-wide `--muted` with counts.

### 9.5 Help overlay

`?` opens a modal (standard Modal) titled 'Keyboard shortcuts': two columns of grouped tables (Global / Calendar / Tasks / Dialogs), `kbd` styling: `--surface-2` bg, `--border` 1px, radius `--r-sm`, min-width 20px, text-xs tabular, `Q` or `Esc` closes.

### 9.6 Editor overflow

Editor form: ONE column always (labels above inputs), inputs full-width `min-width: 0`, start/end side by side only ≥480px in-dialog, modal body scrolls (`max-height: 80dvh; overflow-y: auto`), footer sticky at modal bottom.

### 9.7 Settled decisions

Week-view today chip is the §9.1 square chip (`--accent-soft` bg + `--accent` text, radius 2px); `prefs.density` is consumed document-wide from `<html>` (FixD1's consumer) to scale list/grid paddings (compact default, cozy = roomier rows).

§5 toast addendum: a toast may carry one optional inline action — a small ghost button labelled by its `label` (aria-label identical), e.g. "Undo" on event/task delete toasts; clicking it runs the action and dismisses the toast, and action toasts auto-dismiss after 6s while plain toasts keep the 3.5s default.

### 9.8 Scratch notes

`\` toggles a local-only scratch buffer ("quickly bring up and type into"): a slide-up panel — desktop fixed bottom-left (420px wide, max-height 60vh, `--surface` bg, `--r-lg` radius, `--shadow-2`), mobile (<768px) a full-width bottom sheet. Header: `Scratch` title, `Saved` indicator (muted `text-xs`; pulses `--accent` ~1.5s on each persist — no spinner, saves are debounced so nothing spins), 2-step clear (click → `Sure?` in `--danger`, click again wipes and refocuses; reverts to `Clear` after 3s), close `×` (aria-labelled). The textarea fills the panel, autofocuses with the caret at the end, and uses the app font; `Esc` (or `\` when focus is outside the textarea) closes.

Persistence is localStorage-only (`wycal.notes` = `{ text, updatedAt }`): debounced autosave 400ms after the last keystroke, restored on load. Local-only by design — never synced to CalDAV. While open the panel registers via `bumpDialogOpen`, so the §16 keybinds stay gated and `Q`/`Esc` close it; it does not gate its own toggle (backslash still closes it while it is up).
