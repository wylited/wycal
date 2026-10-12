/** @jsxImportSource preact */
/**
 * Tasks view (CONTRACTS §15, design.md §9.4): Todoist × org-super-agenda agenda.
 *
 * Smart-view tabs up top (segmented, sessionStorage-persisted): Today (due ≤
 * today incl. overdue), Upcoming (next 7 days), Overdue, All. The quick-add
 * line parses natural language first ('Buy milk tomorrow 5pm #A +work' — see
 * ./quickAdd), falling back to org syntax (`Feed the cat :home: #A d:+1w` —
 * see ./tasksModel) for anything the NL pass doesn't match; a live hint under
 * the input previews the parsed bits and Enter creates the todo in the
 * selected visible VTODO calendar. Rows are
 * grouped org-super-agenda style: a day header ('Overdue', 'Today · Sun Oct
 * 11', 'Mon Oct 12', 'No date'), then per-calendar group headers (color dot +
 * name + count), rows sorted all-day-first then time then priority; children
 * indent one level under their parent (relatedTo). Row anatomy (`.todo-row`,
 * W4 CSS hooks): #A/#B/#C priority chip (click cycles 1→5→9→1), done checkbox
 * (STATUS TODO↔COMPLETED via the store), title (strikethrough + muted when
 * done), tag chips (click filters), due chip (danger when overdue, 'Today'
 * when today), hover quick actions: priority cycle · due +1d · edit · two-step
 * delete 'Sure?' confirm (CONTRACTS §21). Shift+N from anywhere pings
 * `wycal:quickadd` on window (W8); here we focus + select the input,
 * idempotently.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { format } from 'date-fns'
import type { IcsDate, IcsTodo } from '../../lib/ics/types'
import {
  icsDateToDate,
  localDateStr,
  localMidnight,
  pad2,
  prioLetter,
  shiftIcsDate,
  toIcsDateInput,
} from '../../lib/ics/types'
import { newUid } from '../../lib/util/id'
import {
  childrenOf,
  createTodo,
  deleteTodo,
  isTodoDone,
  revision,
  todoKey,
  todos,
  toggleDone,
  updateTodo,
  type TodoPatch,
  type TodoRecord,
} from '../../stores/todos'
import { collectionColor, collections, isCalendarVisible, visibilityVersion } from '../../stores/calendars'
import { bumpDialogClose, bumpDialogOpen, isDialogOpen, isEditableTarget } from '../../stores/ui'
import { Icon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { closeTodoEditor, openTodoEditor, todoEditor } from './todoEditor'
import { describeDue, parseQuickAdd } from './quickAdd'
import { openQuickAdd } from '../quickadd/QuickAddDialog'
import { dueTime, parseQuickAdd as parseOrgQuickAdd, treeRows } from './tasksModel'

// ---------------------------------------------------------------------------
// Delete confirm (CONTRACTS §21)
// ---------------------------------------------------------------------------

/**
 * Two-step delete confirm (CONTRACTS §21): the first `activate` arms — the
 * Delete affordance turns into danger 'Sure?' — the second deletes; a 3s
 * timer reverts. `disarm` runs for any other key so the dialog keybind
 * shares the same steps (first press arms, second confirms). File-local to
 * the views owning delete affordances.
 */
function useConfirmDelete(remove: () => void) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  function disarm() {
    setArmed(false)
    window.clearTimeout(timer.current)
  }
  function activate() {
    if (armed) {
      disarm()
      void remove()
      return
    }
    setArmed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(disarm, 3000)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { armed, activate, disarm }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

/** Local-midnight ms of a Date's calendar day (day-bucketing key). */
function dayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Day-light bands for `E`; 1×DAY_MS shifts a due exactly one day. */
const DAY_MS = 86_400_000

/**
 * Row order inside a calendar group (§15 agenda): all-day dues first, then
 * time ascending, then priority band (#A < #B < #C < none), then summary.
 */
function rowCompare(a: TodoRecord, b: TodoRecord): number {
  const allDayA = a.data.due?.date !== undefined ? 0 : 1
  const allDayB = b.data.due?.date !== undefined ? 0 : 1
  if (allDayA !== allDayB) return allDayA - allDayB
  const ta = dueTime(a) ?? Number.MAX_SAFE_INTEGER
  const tb = dueTime(b) ?? Number.MAX_SAFE_INTEGER
  if (ta !== tb) return ta - tb
  const band = (p: number | undefined): number => (p === undefined ? 4 : p <= 3 ? 1 : p <= 6 ? 2 : 3)
  const pa = band(a.data.priority)
  const pb = band(b.data.priority)
  if (pa !== pb) return pa - pb
  return a.data.summary.localeCompare(b.data.summary)
}

/**
 * One agenda row (Todoist anatomy): #A/#B/#C priority chip — itself the
 * cycler (1→5→9→1 band-wise; unset → #A) — done checkbox (STATUS
 * TODO↔COMPLETED via the store), summary (struck-through + muted when done),
 * tag chips (click filters), due chip (danger when overdue, 'Today' when
 * today), then hover quick actions: due +1d · edit · two-step delete
 * (CONTRACTS §21). Class `todo-row` + `data-todo-key` are load-bearing: the
 * `E` keybind locates the focused row's record through them (TasksView below).
 */
function TaskRow(props: {
  rec: TodoRecord
  depth: 0 | 1
  activeTag: string | null
  onTag: (tag: string | null) => void
}) {
  const t = props.rec.data
  const del = useConfirmDelete(() => void deleteTodo(props.rec).catch(() => {}))
  // Inline rename (Todoist-style): double-clicking the summary swaps it for an
  // input; Enter/blur commits via updateTodo, Esc or an empty draft cancels.
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(t.summary)
  const done = t.status === 'COMPLETED'
  const letter = prioLetter(t.priority)
  const due = dueTime(props.rec)
  const today0 = dayMs(new Date())
  const overdue = due !== null && !done && due < today0
  const dueToday = due !== null && due >= today0 && due < today0 + DAY_MS
  const dueTime_ = due !== null && t.due?.date === undefined ? ` ${format(new Date(due), 'HH:mm')}` : ''
  const dueLabel = due === null ? null : `${dueToday ? 'Today' : format(new Date(due), 'MMM d')}${dueTime_}`

  /** Priority cycler: band A → 5 (#B), band B → 9 (#C), band C / unset → 1 (#A). */
  async function cyclePriority(): Promise<void> {
    const p = t.priority
    const next = p === undefined || p > 6 ? 1 : p <= 3 ? 5 : 9
    try {
      await updateTodo(props.rec, { priority: next })
    } catch {
      // The store rolled back and toasted the failure.
    }
  }

  /** Due +1d, preserving the due's form class; undated → tomorrow all-day. */
  async function bumpDue(): Promise<void> {
    const next =
      t.due !== undefined ? shiftIcsDate(t.due, DAY_MS) : toIcsDateInput(new Date(new Date().setHours(24, 0, 0, 0)), true)
    try {
      await updateTodo(props.rec, { due: next })
    } catch {
      // The store rolled back and toasted the failure.
    }
  }

  /** Commit the rename: trim, empty = cancel, unchanged = no-op write. */
  async function commitRename(): Promise<void> {
    if (!renaming) return
    setRenaming(false)
    const s = draft.trim()
    if (s === '' || s === t.summary) return
    try {
      await updateTodo(props.rec, { summary: s })
    } catch {
      // The store rolled back and toasted the failure.
    }
  }

  return (
    <div
      class="todo-row group flex items-center gap-2"
      style={{ paddingLeft: props.depth ? 30 : 10 }}
      data-todo-key={todoKey(t.uid, props.rec.calendarUrl)}
      onDblClick={(e) => {
        // Row background opens the editor; the summary span stops propagation
        // and starts the inline rename instead (e.target check keeps double
        // clicks on the row's controls inert).
        if (e.target === e.currentTarget) openTodoEditor(props.rec)
      }}
    >
      <input
        type="checkbox"
        checked={done}
        title={done ? 'Mark not done' : 'Mark done'}
        aria-label={done ? `Mark ${t.summary} not done` : `Mark ${t.summary} done`}
        onChange={() => void toggleDone(props.rec)}
      />
      {letter !== null ? (
        <button
          type="button"
          class={`todo-badge-${letter.toLowerCase()} shrink-0`}
          title={`Priority #${letter} — click to cycle (A→B→C→A)`}
          aria-label={`Cycle priority of ${t.summary} (current #${letter})`}
          onClick={() => void cyclePriority()}
        >
          #{letter}
        </button>
      ) : (
        <button
          type="button"
          class="todo-badge-none shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          title="Set priority — click to cycle (A→B→C→A)"
          aria-label={`Set priority of ${t.summary}`}
          onClick={() => void cyclePriority()}
        >
          #
        </button>
      )}
      {renaming ? (
        <input
          class="input min-w-0 flex-1 text-sm"
          value={draft}
          autoFocus
          title="Rename task (Enter to save, Esc to cancel)"
          aria-label={`Rename ${t.summary}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitRename()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setRenaming(false)
            }
          }}
          onBlur={() => void commitRename()}
          onDblClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          class={`min-w-0 flex-1 truncate${done ? ' todo-done' : ''}`}
          title={`${t.summary} (double-click to rename)`}
          onDblClick={(e) => {
            e.stopPropagation()
            setDraft(t.summary)
            setRenaming(true)
          }}
        >
          {t.summary}
        </span>
      )}
      {t.categories.map((tag) => (
        <button
          key={tag}
          type="button"
          class={`tag-chip shrink-0${props.activeTag === tag ? ' is-active' : ''}`}
          title={`Filter by tag ${tag}`}
          onClick={() => props.onTag(props.activeTag === tag ? null : tag)}
        >
          {tag}
        </button>
      ))}
      {due !== null && (
        <span
          class={`todo-due-chip shrink-0${overdue ? ' is-overdue' : dueToday ? ' is-today' : ''}`}
          title={overdue ? 'Overdue' : dueToday ? 'Due today' : 'Due'}
        >
          {dueLabel}
        </span>
      )}
      <div class="todo-actions shrink-0">
        <button
          type="button"
          class="btn btn-ghost btn-sm shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          title="Due +1 day"
          aria-label={`Move due of ${t.summary} one day later`}
          onClick={() => void bumpDue()}
        >
          +1d
        </button>
        <button
          type="button"
          class="btn btn-ghost icon-btn btn-sm shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          aria-label="Edit task"
          title="Edit task (E)"
          onClick={() => openTodoEditor(props.rec)}
        >
          <Icon.edit size={14} />
        </button>
        <button
          type="button"
          class={`btn btn-sm shrink-0 max-md:opacity-100 ${
            del.armed
              ? 'btn-danger opacity-100'
              : 'btn-ghost icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
          aria-label={del.armed ? `Confirm deleting ${t.summary}` : `Delete ${t.summary}`}
          title={del.armed ? 'Click again to delete' : 'Delete task'}
          onClick={del.activate}
        >
          {del.armed ? 'Sure?' : <Icon.trash size={14} />}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Todo editor modal (CONTRACTS §14a, design.md §9.6)
// ---------------------------------------------------------------------------

/** Priority segmented values; #A/#B/#C map to the quick-add PRIORITY band values. */
type PrioChoice = 'none' | 'A' | 'B' | 'C'

const PRIO_OPTIONS: SegmentedOption<PrioChoice>[] = [
  { value: 'none', label: 'None', title: 'No priority' },
  { value: 'A', label: '#A', title: 'Priority A' },
  { value: 'B', label: '#B', title: 'Priority B' },
  { value: 'C', label: '#C', title: 'Priority C' },
]

const PRIO_VALUE: Record<Exclude<PrioChoice, 'none'>, 1 | 4 | 7> = { A: 1, B: 4, C: 7 }

/** Labelled field (design.md §5): `--text-xs --muted` label above the control. */
function Field(props: { label: string; children: ComponentChildren }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{props.label}</span>
      {props.children}
    </label>
  )
}

/** Comma/space-separated input → CATEGORIES list; blanks dropped, deduped in order. */
function parseTodoTags(input: string): string[] {
  const out: string[] = []
  for (const tag of input.split(/[\s,]+/)) {
    const t = tag.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out
}

/** Record due → form state: all-day keeps just the date, timed adds HH:MM. */
function dueToForm(d: IcsDate | undefined): { date: string; time: string; timed: boolean } {
  if (d === undefined) return { date: '', time: '', timed: false }
  const date = icsDateToDate(d)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return d.date !== undefined
    ? { date: d.date, time, timed: false }
    : { date: localDateStr(date), time, timed: true }
}

/**
 * Form due → IcsDate: all-day → `;VALUE=DATE` form (quick-add parity), timed
 * → floating wall time (what this app writes for untz'd datetimes). Empty or
 * impossible calendar dates (2026-02-31) → no due.
 */
function dueFromForm(date: string, timed: boolean, time: string): IcsDate | undefined {
  if (date === '' || localDateStr(localMidnight(date)) !== date) return undefined
  if (!timed || time === '') return toIcsDateInput(localMidnight(date), true)
  const [h, m] = time.split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return toIcsDateInput(localMidnight(date), true)
  }
  // Floating `utc` is the wall time encoded as-if-UTC (parse.ts/icsDateToDate
  // convention); Date.UTC of the wall fields produces exactly that string.
  const wall = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m))
  return { utc: wall.toISOString(), floating: true }
}

/** Mounted once by TasksView; renders the edit modal from the `todoEditor` signal. */
function TodoEditorModal() {
  const req = todoEditor.value
  const open = req !== null
  // Register as an open dialog (stores/ui) so global keybinds gate while up.
  useEffect(() => {
    if (!open) return
    bumpDialogOpen()
    return bumpDialogClose
  }, [open])
  if (req === null) return null
  return <TodoEditForm key={req.key} record={req} />
}

/** Single-column §9.6 edit form for one task (edit-only; creation is quick-add). */
function TodoEditForm(props: { record: TodoRecord }) {
  const rec = props.record
  const td = rec.data
  const [summary, setSummary] = useState(td.summary)
  const [summaryError, setSummaryError] = useState(false)
  const [notes, setNotes] = useState(td.description ?? '')
  const [prio, setPrio] = useState<PrioChoice>(prioLetter(td.priority) ?? 'none')
  const [tagsText, setTagsText] = useState(td.categories.join(', '))
  const [due] = useState(() => dueToForm(td.due))
  const [dueDate, setDueDate] = useState(due.date)
  const [dueTimed, setDueTimed] = useState(due.timed)
  const [dueTime, setDueTime] = useState(due.time)
  const [done, setDone] = useState(isTodoDone(td))
  const [busy, setBusy] = useState(false)
  // Two-step delete confirm (CONTRACTS §21): button and keybind share it.
  const del = useConfirmDelete(remove)

  const tags = parseTodoTags(tagsText)

  function removeTag(tag: string): void {
    setTagsText(parseTodoTags(tagsText).filter((t) => t !== tag).join(', '))
  }

  async function save(): Promise<void> {
    const s = summary.trim()
    if (s === '') {
      setSummaryError(true)
      return
    }
    const patch: TodoPatch = {
      summary: s,
      description: notes.trim() || undefined,
      priority: prio === 'none' ? undefined : PRIO_VALUE[prio],
      categories: parseTodoTags(tagsText),
      due: dueFromForm(dueDate, dueTimed, dueTime),
    }
    // Completed checkbox mirrors toggleDone's write (CONTRACTS §12); an
    // unchanged completion keeps the original COMPLETED timestamp verbatim.
    const wasDone = isTodoDone(td)
    if (done && !wasDone) {
      patch.status = 'COMPLETED'
      patch.completed = { utc: new Date().toISOString() }
      patch.percentComplete = 100
    } else if (!done && wasDone) {
      patch.status = 'NEEDS-ACTION'
      patch.completed = undefined
      patch.percentComplete = undefined
    }
    setBusy(true)
    try {
      await updateTodo(rec, patch)
      closeTodoEditor()
    } catch {
      // Store rolled back + toasted; keep the editor open.
      setBusy(false)
    }
  }

  /** Same delete path the row's delete button uses. */
  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await deleteTodo(rec)
      closeTodoEditor()
    } catch {
      // Store rolled back + toasted; keep the editor open.
      setBusy(false)
    }
  }

  /**
   * Dialog keybinds (CONTRACTS §16, mirrors EventEditor), attached at the
   * modal root so they fire from any focused control; propagation stopped so
   * app-level global shortcuts never double-fire while the dialog is open.
   * Esc cancel itself is Modal's focus-trap job (document capture).
   */
  function onDialogKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter' && !e.shiftKey) {
      del.disarm()
      e.preventDefault()
      e.stopPropagation()
      if (!busy) void save()
    } else if (mod && e.shiftKey && e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      // Two-step (CONTRACTS §21): first press arms, second confirms.
      if (!busy) del.activate()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      del.disarm()
    } else {
      // Any other key disarms the delete confirm.
      del.disarm()
    }
  }

  return (
    <div onKeyDown={onDialogKeyDown}>
      <Modal
        open
        title="Edit task"
        width={480}
        onClose={closeTodoEditor}
        footer={
          <>
            <button
              type="button"
              class={`mr-auto ${del.armed ? 'btn btn-danger' : 'btn btn-ghost text-danger'}`}
              title={del.armed ? 'Click again to delete' : 'Delete (⌘⇧⌫)'}
              disabled={busy} onClick={del.activate}
            >
              {del.armed ? 'Sure?' : 'Delete'}
            </button>
            <button type="button" class="btn btn-ghost" title="Cancel (Esc)" disabled={busy} onClick={closeTodoEditor}>
              Cancel
            </button>
            <button
              type="button" class="btn btn-primary" title="Save (⌘⏎)"
              disabled={busy} onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div class="flex flex-col gap-2">
          <Field label="Summary">
            <input
              class="input" value={summary} autoFocus aria-required="true" aria-invalid={summaryError || undefined}
              onInput={(e) => { setSummary(e.currentTarget.value); if (summaryError) setSummaryError(false) }}
            />
            {summaryError && <span class="text-xs text-danger" role="alert">Summary is required</span>}
          </Field>
          <Field label="Notes">
            <textarea class="input resize-y" rows={3} value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
          </Field>
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Priority</span>
            <Segmented<PrioChoice> value={prio} options={PRIO_OPTIONS} onChange={setPrio} ariaLabel="Priority" />
          </div>
          <Field label="Tags">
            <input
              class="input w-full min-w-0" value={tagsText} placeholder="comma or space separated, e.g. work, home"
              onInput={(e) => setTagsText(e.currentTarget.value)}
            />
            {tags.length > 0 && (
              <div class="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <button
                    key={tag} type="button" class="tag-chip" title={`Remove tag ${tag}`}
                    onClick={() => removeTag(tag)}
                  >
                    {tag}
                    <Icon.x size={12} />
                  </button>
                ))}
              </div>
            )}
          </Field>
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Due</span>
            <div class="flex flex-wrap items-center gap-2">
              <input
                type="date" class="input w-full min-w-0 flex-1 tabular-nums" value={dueDate}
                title="Due date" aria-label="Due date" onChange={(e) => setDueDate(e.currentTarget.value)}
              />
              <label class="flex shrink-0 items-center gap-1.5 text-xs text-muted" title="Add a due time">
                <input
                  type="checkbox" checked={dueTimed} aria-label="Due has a time"
                  onChange={(e) => setDueTimed(e.currentTarget.checked)}
                />
                Time
              </label>
              {dueTimed && (
                <input
                  type="time" class="input w-28 shrink-0 tabular-nums" value={dueTime}
                  title="Due time" aria-label="Due time" onChange={(e) => setDueTime(e.currentTarget.value)}
                />
              )}
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox" checked={done} title={done ? 'Mark not done on save' : 'Mark done on save'}
              onChange={(e) => setDone(e.currentTarget.checked)}
            />
            Completed
          </label>
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Smart-view tab (sessionStorage-persisted; default 'today'). */
type SmartTab = 'today' | 'upcoming' | 'overdue' | 'all'

const TAB_KEY = 'wycal.tasks.tab'

const TAB_OPTIONS: SegmentedOption<SmartTab>[] = [
  { value: 'today', label: 'Today', title: 'Due today, including overdue' },
  { value: 'upcoming', label: 'Upcoming', title: 'Due in the next 7 days' },
  { value: 'overdue', label: 'Overdue', title: 'Past due, not done' },
  { value: 'all', label: 'All', title: 'All tasks by day' },
]

/** Per-tab empty states (plain text — house style). */
const EMPTY_TEXT: Record<SmartTab, string> = {
  today: 'Nothing due today',
  upcoming: 'Nothing due in the next 7 days',
  overdue: 'Nothing overdue',
  all: 'No tasks yet — add one above',
}

/** One calendar's rows inside a day bucket (org-super-agenda subgroup). */
interface CalGroup {
  id: string
  name: string
  color: string
  recs: TodoRecord[]
  done: number
}

/** One day section: header label + its calendar subgroups. */
interface DayBucket {
  id: string
  label: string
  kind: 'overdue' | 'today' | 'past' | 'future' | 'undated'
  total: number
  groups: CalGroup[]
}

export function TasksView() {
  const [tab, setTab] = useState<SmartTab>(() => {
    const stored = sessionStorage.getItem(TAB_KEY)
    return stored === 'upcoming' || stored === 'overdue' || stored === 'all' ? stored : 'today'
  })
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [calUrl, setCalUrl] = useState('')

  /** Tab switch persists for the session (per-view, dies with the tab). */
  function onTab(next: SmartTab): void {
    setTab(next)
    try {
      sessionStorage.setItem(TAB_KEY, next)
    } catch {
      // sessionStorage unavailable (private mode) — switch anyway.
    }
  }

  // ~150ms debounce (perf P4): the search input mirrors `query` instantly,
  // the filter+group pipeline below runs on the settled value only.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query), 150)
    return () => window.clearTimeout(t)
  }, [query])

  // Shift+N (W8 global handler) pings twice on window — focus + select the
  // input whether this view was already mounted or is arriving via the route.
  useEffect(() => {
    const focusQuickAdd = (): void => {
      const el = document.getElementById('quick-add')
      if (el instanceof HTMLInputElement) {
        el.focus()
        el.select()
      }
    }
    window.addEventListener('wycal:quickadd', focusQuickAdd)
    return () => window.removeEventListener('wycal:quickadd', focusQuickAdd)
  }, [])

  // `E` (CONTRACTS §14a): open the editor for the row that owns focus.
  // Document-level like app.tsx's global handler, gated on open dialogs and
  // editable targets; the record is found via data-todo-key on the focused
  // element's .todo-row ancestor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'e' || e.metaKey || e.ctrlKey || e.altKey) return
      if (isDialogOpen() || isEditableTarget(e.target)) return
      const focused = document.activeElement
      const row = focused instanceof Element ? focused.closest('.todo-row') : null
      const key = row instanceof HTMLElement ? row.dataset.todoKey : undefined
      const rec = key === undefined ? undefined : todos.value.get(key)
      if (rec === undefined) return
      e.preventDefault()
      openTodoEditor(rec)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Signal reads during render keep this view reactive; the memo reruns the
  // tab → filter → day-bucket → calendar-group pipeline (perf P4) only when a
  // dependency actually changed.
  const rev = revision.value
  const vis = visibilityVersion.value
  const cols = collections.value
  const { days, byUid } = useMemo(() => {
    const all = [...todos.value.values()].filter((r) => isCalendarVisible(r.calendarUrl))
    const uidIndex = new Map<string, TodoRecord>()
    for (const rec of all) if (!uidIndex.has(rec.data.uid)) uidIndex.set(rec.data.uid, rec)
    const today0 = dayMs(new Date())
    const q = search.trim().toLowerCase()
    // Tab predicates (§15 agenda): Today keeps done rows so they strike
    // through in place; Overdue/Upcoming are open-only; All shows everything.
    const filtered = all.filter((rec) => {
      if ((tab === 'upcoming' || tab === 'overdue') && rec.data.status === 'COMPLETED') return false
      const d = rec.data.due !== undefined ? icsDateToDate(rec.data.due).getTime() : null
      const day = d === null ? null : dayMs(new Date(d))
      if (tab === 'today' && (day === null || day > today0)) return false
      if (tab === 'upcoming' && (day === null || day <= today0 || day > today0 + 7 * DAY_MS)) return false
      if (tab === 'overdue' && (day === null || day >= today0)) return false
      if (activeTag && !rec.data.categories.includes(activeTag)) return false
      if (q) {
        const hay = `${rec.data.summary}\n${rec.data.description ?? ''}\n${rec.data.categories.join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    // Day buckets: the due's local calendar day; undated only surfaces in All.
    const buckets = new Map<number, TodoRecord[]>()
    const undated: TodoRecord[] = []
    for (const rec of filtered) {
      if (rec.data.due === undefined) {
        undated.push(rec)
        continue
      }
      const day = dayMs(icsDateToDate(rec.data.due))
      const list = buckets.get(day)
      if (list) list.push(rec)
      else buckets.set(day, [rec])
    }
    const days: DayBucket[] = []
    const year = new Date().getFullYear()

    /** Day label: 'Today · Sun Oct 11' / 'Mon Oct 12' (year when ≠ current). */
    function dayLabel(ms: number): string {
      const d = new Date(ms)
      return d.getFullYear() === year ? format(d, 'EEE MMM d') : format(d, 'EEE MMM d yyyy')
    }

    /**
     * Calendar subgroups in collection order, rows time-then-priority sorted;
     * todos whose calendar vanished from the store land under 'Other'.
     */
    function calGroups(recs: TodoRecord[]): CalGroup[] {
      const out: CalGroup[] = []
      for (const cal of cols) {
        if (cal.kind !== 'calendar') continue
        const inCal = recs.filter((r) => r.calendarUrl === cal.url).sort(rowCompare)
        if (inCal.length === 0) continue
        out.push({ id: cal.url, name: cal.name || cal.url, color: collectionColor(cal), recs: inCal, done: inCal.filter((r) => r.data.status === 'COMPLETED').length })
      }
      const known = new Set(out.map((g) => g.id))
      const rest = recs.filter((r) => !known.has(r.calendarUrl)).sort(rowCompare)
      if (rest.length > 0) out.push({ id: 'other', name: 'Other', color: 'var(--muted)', recs: rest, done: rest.filter((r) => r.data.status === 'COMPLETED').length })
      return out
    }

    function pushDay(id: string, label: string, kind: DayBucket['kind'], recs: TodoRecord[]): void {
      if (recs.length === 0) return
      days.push({ id, label, kind, total: recs.length, groups: calGroups(recs) })
    }

    const dayKeys = [...buckets.keys()].sort((a, b) => a - b)
    if (tab === 'today' || tab === 'overdue') {
      // Past-due buckets collapse under a single danger 'Overdue' header.
      const past = dayKeys.filter((k) => k < today0).flatMap((k) => buckets.get(k) ?? [])
      pushDay('overdue', 'Overdue', 'overdue', past)
    }
    for (const k of dayKeys) {
      if (k < today0) {
        if (tab === 'all') pushDay(String(k), dayLabel(k), 'past', buckets.get(k) ?? [])
      } else if (k === today0) {
        if (tab !== 'overdue') pushDay(String(k), `Today · ${dayLabel(k)}`, 'today', buckets.get(k) ?? [])
      } else if (tab === 'upcoming' || tab === 'all') {
        pushDay(String(k), dayLabel(k), 'future', buckets.get(k) ?? [])
      }
    }
    if (tab === 'all') pushDay('undated', 'No date', 'undated', undated)
    return { days, byUid: uidIndex }
  }, [tab, search, activeTag, rev, vis, cols])

  const todoCals = collections.value.filter(
    (c) => c.kind === 'calendar' && c.components.includes('VTODO') && isCalendarVisible(c.url),
  )
  const selected = todoCals.some((c) => c.url === calUrl) ? calUrl : (todoCals[0]?.url ?? '')

  // Live quick-add hint: the parsed bits ('→ Fri Oct 16 · 5:00pm · #A · +work')
  // as the user types — the same two-pass parse (NL, then org fallback) that
  // Enter applies, so the preview never lies about what will be created.
  const quickHint = useMemo(() => {
    if (text.trim() === '') return ''
    const nl = parseQuickAdd(text)
    const org = parseOrgQuickAdd(nl.summary)
    const parsedDue =
      nl.due ??
      (org.due !== undefined ? { date: icsDateToDate(org.due), allDay: org.due.date !== undefined } : undefined)
    const bits: string[] = []
    if (parsedDue !== undefined) bits.push(describeDue(parsedDue))
    const letter = prioLetter(nl.priority ?? org.priority)
    if (letter !== null) bits.push(`#${letter}`)
    for (const tag of new Set([...nl.tags, ...org.categories])) bits.push(`+${tag}`)
    return bits.length === 0 ? '' : `→ ${bits.join(' · ')}`
  }, [text])

  async function submitQuickAdd(): Promise<void> {
    // Natural-language pass first ('Buy milk tomorrow 5pm #A +work'), then the
    // org-syntax parser over the stripped remainder (`:home:`, `d:+1w`); when
    // both match the same field the NL match wins (CONTRACTS §15).
    const nl = parseQuickAdd(text)
    const org = parseOrgQuickAdd(nl.summary)
    if (!org.summary || !selected) return
    const due = nl.due
      ? dueFromForm(
          localDateStr(nl.due.date),
          !nl.due.allDay,
          `${pad2(nl.due.date.getHours())}:${pad2(nl.due.date.getMinutes())}`,
        )
      : org.due
    const todo: IcsTodo = {
      uid: newUid(),
      summary: org.summary,
      status: 'NEEDS-ACTION',
      categories: [...new Set([...nl.tags, ...org.categories])],
      priority: nl.priority ?? org.priority,
      due,
      exdates: [],
      alarms: [],
    }
    try {
      await createTodo(selected, todo)
      setText('')
    } catch {
      // The store rolled back and toasted the failure.
    }
  }

  if (todoCals.length === 0) {
    return (
      <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Icon.check size={24} />
        <p class="text-sm">No task lists yet</p>
        <p class="text-xs">Calendars supporting tasks (VTODO) appear here once synced.</p>
        <TodoEditorModal />
      </div>
    )
  }

  return (
    <div class="tasks-view flex h-full min-h-0 flex-col">
      <div class="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2">
        <Segmented<SmartTab> value={tab} options={TAB_OPTIONS} onChange={onTab} ariaLabel="Task view" />
        <button
          type="button" class="btn btn-primary" title="New task (Q)"
          onClick={() => openQuickAdd('todo')}
        >
          + New task
        </button>
        <div class="min-w-3 flex-1" />
        <input
          class="input w-44 text-sm"
          placeholder="Search…"
          value={query}
          title="Search tasks"
          aria-label="Search tasks"
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <form
        class="flex items-center gap-2 px-5 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submitQuickAdd()
        }}
      >
        <div class="quickadd min-w-0 flex-1">
          <input
            id="quick-add"
            class="input w-full text-sm"
            placeholder="Feed the cat :home: #A d:+1w"
            value={text}
            autoFocus
            title="Quick-add task (Shift+N)"
            aria-label="Quick-add task"
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </div>
        <select
          class="input w-44 shrink-0 text-sm"
          value={selected}
          title="Calendar for new tasks"
          aria-label="Calendar for new tasks"
          onChange={(e) => setCalUrl(e.currentTarget.value)}
        >
          {todoCals.map((c) => (
            <option key={c.url} value={c.url}>{c.name || c.url}</option>
          ))}
        </select>
      </form>
      {quickHint !== '' && (
        <div class="px-5 pb-1 text-xs text-muted" role="status" aria-live="polite">
          {quickHint}
        </div>
      )}
      {activeTag && (
        <div class="flex items-center gap-2 px-5 pb-1 text-xs text-muted">
          Tag
          <button type="button" class="tag-chip is-active" title="Clear tag filter" onClick={() => setActiveTag(null)}>
            {activeTag}
            <Icon.x size={12} />
          </button>
        </div>
      )}
      <div class="agenda min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-6">
        {days.length === 0 ? (
          <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
            <Icon.check size={24} />
            <p class="text-sm">
              {search.trim() !== '' || activeTag !== null ? 'No tasks match' : EMPTY_TEXT[tab]}
            </p>
          </div>
        ) : (
          days.map((day) => (
            <section class="agenda-day" key={day.id}>
              <header class={`agenda-day-head${day.kind === 'overdue' ? ' is-overdue' : ''}`}>
                <h2>{day.label}</h2>
                <span class="agenda-day-count tabular-nums">{day.total}</span>
              </header>
              {day.groups.map((g) => (
                <div class="agenda-cal" key={g.id}>
                  <div class="agenda-cal-head">
                    <span class="chip-dot shrink-0" style={{ backgroundColor: g.color }} title={g.name} />
                    <span class="agenda-cal-name">{g.name}</span>
                    <span class="agenda-cal-count tabular-nums">({g.recs.length})</span>
                  </div>
                  {treeRows(g.recs, byUid, rowCompare, childrenOf).map((row) => (
                    <TaskRow
                      key={row.rec.key}
                      rec={row.rec}
                      depth={row.depth}
                      activeTag={activeTag}
                      onTag={setActiveTag}
                    />
                  ))}
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      <TodoEditorModal />
    </div>
  )
}
