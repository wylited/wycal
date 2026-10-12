/**
 * Scratch-notes store (design.md §9.8): a local-only buffer for quick
 * thoughts. The panel (`views/notes/ScratchNotes.tsx`) toggles via the
 * global `\` keybind; text is debounced-autosaved to localStorage
 * (`wycal.notes` = `{ text, updatedAt }`) 400ms after the last keystroke.
 * Local-only by design — notes never sync to the CalDAV server.
 */
import { signal } from '@preact/signals'

const STORAGE_KEY = 'wycal.notes'
const DEBOUNCE_MS = 400

interface StoredNotes {
  text: string
  updatedAt: number
}

/** Load the stored buffer; absent or corrupt storage degrades to empty text. */
function load(): StoredNotes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { text: '', updatedAt: 0 }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { text: '', updatedAt: 0 }
    const rec = parsed as Partial<StoredNotes>
    return {
      text: typeof rec.text === 'string' ? rec.text : '',
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
    }
  } catch {
    return { text: '', updatedAt: 0 }
  }
}

const stored = load()

/** Panel visibility (toggled by the global `\` keybind, design.md §9.8). */
export const notesOpen = signal(false)

/** Current scratch text (edited live in the textarea). */
export const notesText = signal(stored.text)

/** Epoch ms of the last completed persist (drives the 'Saved' indicator). */
export const lastSavedAt = signal(stored.updatedAt)

let saveTimer: number | undefined

/** Update the buffer and (re)arm the 400ms autosave debounce. */
export function setNotesText(text: string): void {
  notesText.value = text
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(persist, DEBOUNCE_MS)
}

function persist(): void {
  const record: StoredNotes = { text: notesText.value, updatedAt: Date.now() }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    lastSavedAt.value = record.updatedAt
  } catch {
    // Storage unavailable (quota/private mode): the buffer stays in memory
    // for the session — nothing more to do, the store is local-only by design.
  }
}
