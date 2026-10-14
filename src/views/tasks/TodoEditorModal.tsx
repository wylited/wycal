/** @jsxImportSource preact */
/**
 * Todo editor modal (CONTRACTS §14a): the TasksView-era edit modal rebuilt as
 * an app-shell singleton mounted beside EventEditor (the original component
 * was deleted with TasksView — that doc's §14a header describes the old
 * contract). Named TodoEditorModal because a sibling `TodoEditor.tsx` would
 * case-collide with the `todoEditor.ts` signal module on case-insensitive
 * filesystems. Opens from the `todoEditor` request signal
 * (src/views/tasks/todoEditor.ts) — §9.4 pencil, row double-click, `E` — and
 * from the detail popovers' Edit buttons.
 *
 * Save PUTs through stores/todos `updateTodo` (merged onto the live record —
 * untouched fields like description/alarms survive; no collection moves).
 * Status transitions mirror `toggleDone`/`cycleTodoStatus`: entering
 * COMPLETED stamps COMPLETED-now + PERCENT-COMPLETE 100, leaving clears both.
 * Due is an all-day date input (clearable → DUE removed). Delete is the §21
 * two-step confirm ('Sure?', danger fill, 3s revert) over the same
 * `deleteTodo` path the rows/popovers use (its undo toast is the store's).
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { closeTodoEditor, todoEditor } from './todoEditor'
import { deleteTodo, updateTodo } from '../../stores/todos'
import type { TodoPatch } from '../../stores/todos'
import { collections } from '../../stores/calendars'
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui'
import { Modal } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { icsDateToDate, localDateStr, localMidnightIso, prioLetter } from '../../lib/ics/types'
import type { IcsTodo } from '../../lib/ics/types'

/** #A/#B/#C quick bands — same values TodoDetailPopover's PRIO_VALUE writes. */
const PRIO_VALUE = { A: 1, B: 4, C: 7 } as const
type Prio = keyof typeof PRIO_VALUE | 'none'

const STATUS_OPTIONS: { value: IcsTodo['status']; label: string; title: string }[] = [
  { value: 'NEEDS-ACTION', label: 'Todo', title: 'STATUS:NEEDS-ACTION' },
  { value: 'IN-PROCESS', label: 'Doing', title: 'STATUS:IN-PROCESS' },
  { value: 'COMPLETED', label: 'Done', title: 'STATUS:COMPLETED' },
]

const PRIO_OPTIONS: { value: Prio; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'A', label: '#A' },
  { value: 'B', label: '#B' },
  { value: 'C', label: '#C' },
]

/** 'YYYY-MM-DD' of the due date (timed dues fold to their local date). */
function dueInputValue(td: IcsTodo): string {
  if (!td.due) return ''
  return td.due.date ?? localDateStr(icsDateToDate(td.due))
}

/**
 * Two-step delete confirm (CONTRACTS §21, same pattern as the detail
 * popovers): the first `activate` arms — the Delete button turns into danger
 * 'Sure?' — the second deletes; a 3s timer reverts. File-local to the views
 * owning delete affordances.
 */
function useConfirmDelete(remove: () => Promise<void>) {
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

export function TodoEditor() {
  const rec = todoEditor.value
  const td = rec?.data

  const [summary, setSummary] = useState('')
  const [summaryError, setSummaryError] = useState(false)
  const [status, setStatus] = useState<IcsTodo['status']>('NEEDS-ACTION')
  const [prio, setPrio] = useState<Prio>('none')
  const [due, setDue] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function remove(): Promise<void> {
    const cur = todoEditor.value
    if (!cur) return
    setDeleting(true)
    try {
      await deleteTodo(cur)
      closeTodoEditor()
    } catch {
      // Store rolled back + toasted; keep the editor open.
    } finally {
      setDeleting(false)
    }
  }

  const del = useConfirmDelete(remove)

  // Re-init the form on every open (keyed on the record slot, so closing and
  // reopening the SAME record also resets stale edits + armed delete;
  // CANCELLED counts as Todo per the store's status conventions — the
  // segmented offers the three org statuses).
  useEffect(() => {
    if (!rec) {
      del.disarm()
      return
    }
    const d = rec.data
    setSummary(d.summary)
    setSummaryError(false)
    setStatus(d.status === 'COMPLETED' || d.status === 'IN-PROCESS' ? d.status : 'NEEDS-ACTION')
    setPrio(prioLetter(d.priority) ?? 'none')
    setDue(dueInputValue(d))
    setTags(d.categories.join(', '))
    setSaving(false)
    setDeleting(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- disarm/setters are stable
  }, [rec])

  // §16 dialog gate while open: global keybinds stand down.
  useEffect(() => {
    if (!rec) return
    bumpDialogOpen()
    return bumpDialogClose
  }, [rec])

  if (!rec || !td) return null

  const cal = collections.value.find((c) => c.url === rec.calendarUrl)

  async function save(): Promise<void> {
    // Function declarations hoist above the mount guard, so narrow here too.
    if (!rec || !td) return
    if (!summary.trim()) {
      setSummaryError(true)
      return
    }
    const patch: TodoPatch = {
      summary: summary.trim(),
      status,
      priority: prio === 'none' ? undefined : PRIO_VALUE[prio],
      due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? { utc: localMidnightIso(due), date: due } : undefined,
      categories: tags.split(',').map((t) => t.trim()).filter(Boolean),
      // toggleDone parity on status edges; a stay-COMPLETED edit keeps its stamp.
      ...(status === 'COMPLETED' && td.status !== 'COMPLETED'
        ? { completed: { utc: new Date().toISOString() }, percentComplete: 100 }
        : {}),
      ...(status !== 'COMPLETED' && td.status === 'COMPLETED'
        ? { completed: undefined, percentComplete: undefined }
        : {}),
    }
    setSaving(true)
    try {
      // updateTodo re-resolves the live record/etag at run time, so a quick
      // action that landed while the modal was open cannot race this PUT.
      await updateTodo(rec, patch)
      closeTodoEditor()
    } catch {
      // Store rolled back + toasted; keep the editor open.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onKeyDown={(e) => {
        // §14a keybind: ⌘/Ctrl+Enter saves.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          if (!saving && !deleting) void save()
        }
      }}
    >
      <Modal
        open
        title="Edit task"
        width={480}
        onClose={() => {
          if (!saving && !deleting) closeTodoEditor()
        }}
        footer={
          <>
            <button
              type="button"
              class={`mr-auto ${del.armed ? 'btn btn-danger animate-pulse' : 'btn btn-ghost text-danger'}`}
              title={del.armed ? 'Click again to delete' : 'Delete task'}
              aria-label={del.armed ? 'Click again to delete' : 'Delete task'}
              disabled={saving || deleting}
              onClick={del.activate}
            >
              {del.armed ? 'Sure?' : 'Delete'}
            </button>
            <button type="button" class="btn btn-ghost" title="Cancel (Esc)" onClick={closeTodoEditor}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              title="Save (⌘⏎)"
              disabled={saving || deleting}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <div class="flex flex-col gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Summary</span>
            <input
              class="input"
              value={summary}
              autoFocus
              aria-required="true"
              aria-invalid={summaryError || undefined}
              onInput={(e) => {
                setSummary(e.currentTarget.value)
                if (summaryError) setSummaryError(false)
              }}
            />
            {summaryError && (
              <span class="text-xs text-danger" role="alert">
                Summary is required
              </span>
            )}
          </label>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Status</span>
            <Segmented
              value={status}
              options={STATUS_OPTIONS}
              onChange={setStatus}
              ariaLabel="Status"
              class="self-start"
            />
          </div>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Priority</span>
            <Segmented
              value={prio}
              options={PRIO_OPTIONS}
              onChange={setPrio}
              ariaLabel="Priority"
              class="self-start"
            />
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Due</span>
            <input
              type="date"
              class="input self-start tabular-nums"
              value={due}
              aria-label="Due date"
              onChange={(e) => setDue(e.currentTarget.value)}
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Tags</span>
            <input
              class="input"
              value={tags}
              placeholder="comma, separated"
              onInput={(e) => setTags(e.currentTarget.value)}
            />
          </label>

          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Calendar</span>
            <span class="text-sm text-fg">{cal ? cal.name : rec.calendarUrl}</span>
          </div>
        </div>
      </Modal>
    </div>
  )
}
