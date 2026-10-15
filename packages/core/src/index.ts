/**
 * @wycal/core barrel (CONTRACTS §36): framework-agnostic calendar core —
 * ICS/VCard/CalDAV, sync engine, stores, quick-add NL grammar, search.
 * No DOM/browser APIs; persistence only via the kv seam.
 */
export * from './lib/kv'

// -- lib ---------------------------------------------------------------------
export * from './lib/agenda/agendaModel'
export * from './lib/caldav/client'
export * from './lib/caldav/types'
export * from './lib/caldav/xml'
export * from './lib/ics/expand'
export * from './lib/ics/parse'
export * from './lib/ics/recurrence'
export * from './lib/ics/serialize'
export * from './lib/ics/tz'
export * from './lib/ics/types'
// util/date re-exported named: `icsDateToDate` collides with lib/ics/types.
export {
  canonicalInstant,
  allDayIcsDate,
  parseRecId,
  mirrorIcsDate,
  fmtTime,
  fmtDate,
  dayKey,
  startOfWeek,
  addDays,
  addMinutes,
  setRruleUntil,
  rruleWithoutUntil,
  rruleCount,
  setRruleParam,
  countOccurrencesBefore,
} from './lib/util/date'
export * from './lib/util/colors'
export * from './lib/util/id'
export * from './lib/vcard/parse'
export * from './lib/vcard/serialize'
export * from './lib/vcard/text'
export * from './lib/vcard/types'
export * from './lib/sync/discovery'
export * from './lib/sync/engine'
export * from './lib/sync/scheduler'

// -- stores -------------------------------------------------------------------
export * from './stores/accounts'
export * from './stores/agendaFilters'
export * from './stores/calendars'
export * from './stores/caldefaults'
export * from './stores/contacts'
export * from './stores/events'
// todos re-exported named: its `revision` collides with stores/events.
export type { TodoRecord, TodoPatch } from './stores/todos'
export {
  todos,
  revision as todoRevision,
  todoKey,
  applyTodoCollectionSync,
  createTodo,
  updateTodo,
  deleteTodo,
  toggleDone,
  cycleTodoStatus,
  setTodoPriority,
  setTodoDue,
  isTodoDone,
  childrenOf,
  stuckTopLevel,
} from './stores/todos'
export * from './stores/prefs'
// snapshot re-exported named: the per-store serialize/hydrate functions
// share names, so their star exports stay subpath-only
// (`@wycal/core/stores/<store>`); the aggregate is the barrel surface.
export { SNAPSHOT_VERSION, serializeSnapshot, hydrateSnapshot, type WycalSnapshot } from './stores/snapshot'
export * from './stores/toasts'

// -- nl + search ---------------------------------------------------------------
export * from './nl/quickAdd'
export * from './nl/nl'
export * from './search/searchEngine'
