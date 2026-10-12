/** @jsxImportSource preact */
/**
 * Email/TEL row lists for the contact editor: value input + single type
 * select + remove button per row, plus an add-row button. Rows keep the
 * entry's full TYPE list; the select shows the first known option (any
 * unrecognized current type renders as its own option so it round-trips
 * verbatim), and picking one replaces the list.
 */
import { Icon } from '../../ui/icons'

/** One editor row of the EMAIL/TEL lists. */
export interface Row {
  value: string
  types: string[]
}

/** Add/remove rows of value + type select (EMAIL/TEL lists in the editor). */
export function RowList(props: {
  label: string
  inputType: 'email' | 'tel'
  placeholder: string
  options: readonly string[]
  rows: Row[]
  removeLabel: string
  addLabel: string
  onChange: (rows: Row[]) => void
}) {
  function update(index: number, patch: Partial<Row>): void {
    props.onChange(props.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  return (
    <div>
      <span class="mb-1 block text-xs font-medium text-muted">{props.label}</span>
      <div class="flex flex-col gap-2">
        {props.rows.map((row, index) => {
          const selected = props.options.find((o) => row.types.includes(o)) ?? row.types[0] ?? ''
          return (
            <div key={index} class="flex items-center gap-2">
              <input
                type={props.inputType}
                class="input"
                placeholder={props.placeholder}
                value={row.value}
                onInput={(e) => update(index, { value: e.currentTarget.value })}
              />
              <select
                class="input w-24 shrink-0"
                value={selected}
                aria-label={`${props.label} type`}
                onChange={(e) =>
                  update(index, { types: e.currentTarget.value === '' ? [] : [e.currentTarget.value] })
                }
              >
                <option value="">Type</option>
                {selected !== '' && !props.options.includes(selected) && (
                  <option value={selected}>{selected.charAt(0).toUpperCase() + selected.slice(1)}</option>
                )}
                {props.options.map((o) => (
                  <option key={o} value={o}>
                    {o.charAt(0).toUpperCase() + o.slice(1)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                class="btn btn-ghost icon-btn btn-sm shrink-0"
                aria-label={props.removeLabel}
                onClick={() => props.onChange(props.rows.filter((_, i) => i !== index))}
              >
                <Icon.x size={14} />
              </button>
            </div>
          )
        })}
        <div>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => props.onChange([...props.rows, { value: '', types: [] }])}
          >
            <Icon.plus size={14} />
            {props.addLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
