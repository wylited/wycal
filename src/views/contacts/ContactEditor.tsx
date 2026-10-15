/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { createContact, updateContact, deleteContact } from '@wycal/core/stores/contacts'
import type { ContactPatch, ContactRecord } from '@wycal/core/stores/contacts'
import type { Vcard } from '@wycal/core/lib/vcard/types'
import { newUid } from '@wycal/core/lib/util/id'
import { Icon } from '../../ui/icons'
import { Modal } from '../../ui/Modal'
import { RowList, type Row } from './ContactRows'

interface AddressForm {
  street: string
  city: string
  region: string
  postcode: string
  country: string
}

interface ContactForm {
  fn: string
  given: string
  family: string
  org: string
  title: string
  /** Birthday as the native date input writes it (yyyy-mm-dd, '' = unset). */
  bday: string
  /** True once the user edited the birthday input ('' then means "clear"). */
  bdayTouched: boolean
  /** Photo URL input ('' = unset; base64 data: photos are not editable here). */
  photo: string
  /** True once the user edited the photo input ('' then means "remove"). */
  photoTouched: boolean
  /** Comma-separated CATEGORIES tags input (same UX as event tags). */
  tags: string
  /** True once the user edited the tags input (untouched keeps them verbatim). */
  tagsTouched: boolean
  emails: Row[]
  tels: Row[]
  address: AddressForm
  note: string
}

const EMPTY_ADDRESS: AddressForm = { street: '', city: '', region: '', postcode: '', country: '' }

/** Shared EMAIL/TEL type options (vCard 4.0 TYPE tokens, lowercase). */
const TYPE_OPTIONS = ['home', 'work', 'cell', 'other'] as const

/** Comma-separated tags input → CATEGORIES list; blanks dropped, values trimmed. */
function parseTags(input: string): string[] {
  return input.split(',').map((t) => t.trim()).filter((t) => t !== '')
}

/**
 * BDAY → native date input value. Full dates in dashed (`1990-06-15`) or
 * compact (`19900615`) form prefill the input; anything else (`--06-15`,
 * free text) has no input representation and stays '' — preserved verbatim
 * on save while untouched.
 */
function bdayToInput(bday: string | undefined): string {
  if (bday === undefined) return ''
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(bday)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** PHOTO → URL input value; base64 data: photos are not editable here. */
function photoToInput(photo: string | undefined): string {
  if (photo === undefined || /^data:/i.test(photo)) return ''
  return photo
}

function blankForm(): ContactForm {
  return {
    fn: '',
    given: '',
    family: '',
    org: '',
    title: '',
    bday: '',
    bdayTouched: false,
    photo: '',
    photoTouched: false,
    tags: '',
    tagsTouched: false,
    emails: [{ value: '', types: [] }],
    tels: [{ value: '', types: [] }],
    address: { ...EMPTY_ADDRESS },
    note: '',
  }
}

/** ADR value → form fields: pobox;extended;street;locality;region;postal;country. */
function addressFromValue(value: string | undefined): AddressForm {
  const p = value !== undefined ? value.split(';') : []
  const at = (i: number): string => p[i] ?? ''
  return { street: at(2), city: at(3), region: at(4), postcode: at(5), country: at(6) }
}

/** Form fields → ADR value, trailing empty components trimmed (vcard ADR convention). */
function addressToValue(a: AddressForm): string {
  const parts = ['', '', a.street.trim(), a.city.trim(), a.region.trim(), a.postcode.trim(), a.country.trim()]
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.join(';')
}

function formFromVcard(v: Vcard | undefined): ContactForm {
  if (v === undefined) return blankForm()
  return {
    fn: v.fn,
    given: v.names?.given ?? '',
    family: v.names?.family ?? '',
    org: v.org ?? '',
    title: v.title ?? '',
    bday: bdayToInput(v.bday),
    bdayTouched: false,
    photo: photoToInput(v.photo),
    photoTouched: false,
    tags: v.categories.join(', '),
    tagsTouched: false,
    emails: v.emails.length > 0 ? v.emails.map((e) => ({ value: e.value, types: [...e.types] })) : [{ value: '', types: [] }],
    tels: v.tels.length > 0 ? v.tels.map((t) => ({ value: t.value, types: [...t.types] })) : [{ value: '', types: [] }],
    address: addressFromValue(v.addresses[0]?.value),
    note: v.note ?? '',
  }
}

function cleanRows(rows: Row[]): { value: string; types: string[] }[] {
  return rows
    .filter((r) => r.value.trim() !== '')
    .map((r) => ({ value: r.value.trim(), types: r.types.filter((t) => t !== '') }))
}

function vcardFromForm(form: ContactForm, uid: string, source: Vcard | undefined): Vcard {
  const names =
    form.given.trim() !== '' || form.family.trim() !== ''
      ? { family: form.family.trim(), given: form.given.trim() }
      : undefined
  const addressValue = addressToValue(form.address)
  // BDAY/PHOTO: untouched fields keep the card's value verbatim (covers the
  // forms the native inputs cannot represent); touched ones take the input —
  // BDAY serializes compact (`19900615`), empty means "omit the property".
  const bday = form.bdayTouched
    ? form.bday !== ''
      ? form.bday.replaceAll('-', '')
      : undefined
    : source?.bday
  const photo = form.photoTouched ? (form.photo.trim() !== '' ? form.photo.trim() : undefined) : source?.photo
  // Tags: untouched input keeps the card's categories verbatim (mirrors BDAY/
  // PHOTO), touched input parses the comma-separated list (clear = remove all).
  const categories = form.tagsTouched ? parseTags(form.tags) : (source?.categories ?? [])
  return {
    uid,
    fn: form.fn.trim(),
    names,
    emails: cleanRows(form.emails),
    tels: cleanRows(form.tels),
    org: form.org.trim() !== '' ? form.org.trim() : undefined,
    title: form.title.trim() !== '' ? form.title.trim() : undefined,
    bday,
    photo,
    categories,
    note: form.note.trim() !== '' ? form.note.trim() : undefined,
    addresses: addressValue !== '' ? [{ value: addressValue, types: [] }] : [],
    raw: '',
  }
}

/** New/edit contact modal (design.md §5): 480px centered, mobile bottom-sheet via Modal. */
export function ContactEditor(props: {
  open: boolean
  /** null → create mode; otherwise patch this record. */
  record: ContactRecord | null
  /** Addressbook collection URL for createContact (create mode). */
  addressbookUrl: string
  /** Command-palette contact candidate (create mode): seeds fn/email/tel. */
  initial?: { fn: string; email?: string; tel?: string }
  onClose: () => void
}) {
  const [form, setForm] = useState<ContactForm>(blankForm)
  const [fnInvalid, setFnInvalid] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  // Re-seed the form each time the modal opens for a given target.
  useEffect(() => {
    if (!props.open) return
    if (props.record === null && props.initial) {
      const seed = blankForm()
      setForm({
        ...seed,
        fn: props.initial.fn,
        emails: props.initial.email ? [{ value: props.initial.email, types: [] }] : seed.emails,
        tels: props.initial.tel ? [{ value: props.initial.tel, types: [] }] : seed.tels,
      })
    } else {
      setForm(formFromVcard(props.record?.data))
    }
    setFnInvalid(false)
    setConfirmDelete(false)
    setBusy(false)
  }, [props.open, props.record])

  function setField<K extends keyof ContactForm>(key: K, value: ContactForm[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function save(): Promise<void> {
    if (form.fn.trim() === '') {
      setFnInvalid(true)
      return
    }
    if (props.record === null && props.addressbookUrl === '') return
    setBusy(true)
    try {
      if (props.record) {
        const v = vcardFromForm(form, props.record.data.uid, props.record.data)
        const patch: ContactPatch = {
          fn: v.fn,
          names: v.names,
          emails: v.emails,
          tels: v.tels,
          org: v.org,
          title: v.title,
          bday: v.bday,
          photo: v.photo,
          categories: v.categories,
          note: v.note,
          addresses: v.addresses,
        }
        await updateContact(props.record, patch)
      } else {
        await createContact(props.addressbookUrl, vcardFromForm(form, newUid(), undefined))
      }
      props.onClose()
    } catch {
      // Store rolled back and toasted the failure; keep the editor open.
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (props.record === null) return
    setBusy(true)
    try {
      await deleteContact(props.record)
      props.onClose()
    } catch {
      setBusy(false)
      setConfirmDelete(false)
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
      e.preventDefault()
      e.stopPropagation()
      if (!busy) void save()
    } else if (mod && e.shiftKey && e.key === 'Backspace' && props.record !== null) {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) void remove()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
    }
  }

  return (
    <div onKeyDown={onDialogKeyDown}>
      <Modal
      open={props.open}
      title={props.record ? 'Edit contact' : 'New contact'}
      onClose={() => {
        if (!busy) props.onClose()
      }}
      footer={
        <div class="flex w-full items-center gap-2">
          {props.record !== null &&
            (confirmDelete ? (
              <span class="flex items-center gap-2 text-sm text-muted">
                Delete?
                <button type="button" class="btn btn-danger btn-sm" onClick={remove} disabled={busy}>
                  Yes
                </button>
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" class="btn btn-ghost text-danger" onClick={() => setConfirmDelete(true)}>
                <Icon.trash size={14} />
                Delete
              </button>
            ))}
          <div class="flex-1" />
          <button type="button" class="btn btn-ghost" onClick={props.onClose} disabled={busy} title="Cancel (Esc)">
            Cancel
          </button>
          <button type="button" class="btn btn-primary" onClick={save} disabled={busy} title="Save (⌘⏎)">
            Save
          </button>
        </div>
      }
    >
      <div class="flex flex-col gap-3">
        <div class="grid grid-cols-2 gap-3">
          <Field label="First name">
            <input
              type="text"
              class="input"
              value={form.given}
              onInput={(e) => setField('given', e.currentTarget.value)}
            />
          </Field>
          <Field label="Last name">
            <input
              type="text"
              class="input"
              value={form.family}
              onInput={(e) => setField('family', e.currentTarget.value)}
            />
          </Field>
        </div>
        <Field label="Display name">
          <input
            type="text"
            class="input"
            required
            aria-required="true"
            aria-invalid={fnInvalid ? 'true' : undefined}
            value={form.fn}
            onInput={(e) => {
              setField('fn', e.currentTarget.value)
              if (fnInvalid) setFnInvalid(false)
            }}
          />
          {fnInvalid && <p class="mt-1 text-xs text-danger">Display name is required</p>}
        </Field>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Organization">
            <input type="text" class="input" value={form.org} onInput={(e) => setField('org', e.currentTarget.value)} />
          </Field>
          <Field label="Title">
            <input type="text" class="input" value={form.title} onInput={(e) => setField('title', e.currentTarget.value)} />
          </Field>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Birthday">
            <input
              type="date"
              class="input"
              value={form.bday}
              onChange={(e) => setForm((f) => ({ ...f, bday: e.currentTarget.value, bdayTouched: true }))}
            />
          </Field>
          <Field label="Photo URL">
            <input
              type="url"
              class="input"
              placeholder="https://example.com/photo.jpg"
              value={form.photo}
              onInput={(e) => setForm((f) => ({ ...f, photo: e.currentTarget.value, photoTouched: true }))}
            />
          </Field>
        </div>
        <Field label="Tags">
          <input
            type="text"
            class="input"
            placeholder="comma-separated, e.g. work, travel"
            value={form.tags}
            onInput={(e) => setForm((f) => ({ ...f, tags: e.currentTarget.value, tagsTouched: true }))}
          />
          {parseTags(form.tags).length > 0 && (
            <div class="flex flex-wrap gap-1">
              {parseTags(form.tags).map((t, i) => (
                <span key={`${t}-${i}`} class="tag-chip">
                  {t}
                </span>
              ))}
            </div>
          )}
        </Field>
        <RowList
          label="Emails"
          inputType="email"
          placeholder="name@example.com"
          options={TYPE_OPTIONS}
          rows={form.emails}
          removeLabel="Remove email"
          addLabel="Add email"
          onChange={(rows) => setField('emails', rows)}
        />
        <RowList
          label="Phones"
          inputType="tel"
          placeholder="+1 555 000 0000"
          options={TYPE_OPTIONS}
          rows={form.tels}
          removeLabel="Remove phone"
          addLabel="Add phone"
          onChange={(rows) => setField('tels', rows)}
        />
        <Field label="Street">
          <input
            type="text"
            class="input"
            value={form.address.street}
            onInput={(e) => setField('address', { ...form.address, street: e.currentTarget.value })}
          />
        </Field>
        <div class="grid grid-cols-2 gap-3">
          <Field label="City">
            <input
              type="text"
              class="input"
              value={form.address.city}
              onInput={(e) => setField('address', { ...form.address, city: e.currentTarget.value })}
            />
          </Field>
          <Field label="Region">
            <input
              type="text"
              class="input"
              value={form.address.region}
              onInput={(e) => setField('address', { ...form.address, region: e.currentTarget.value })}
            />
          </Field>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Postcode">
            <input
              type="text"
              class="input"
              value={form.address.postcode}
              onInput={(e) => setField('address', { ...form.address, postcode: e.currentTarget.value })}
            />
          </Field>
          <Field label="Country">
            <input
              type="text"
              class="input"
              value={form.address.country}
              onInput={(e) => setField('address', { ...form.address, country: e.currentTarget.value })}
            />
          </Field>
        </div>
        <Field label="Note">
          <textarea class="input" rows={3} value={form.note} onInput={(e) => setField('note', e.currentTarget.value)} />
        </Field>
      </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Field(props: { label: string; children: ComponentChildren }) {
  return (
    <label class="block">
      <span class="mb-1 block text-xs font-medium text-muted">{props.label}</span>
      {props.children}
    </label>
  )
}
