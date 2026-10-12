/** @jsxImportSource preact */
/**
 * 'New calendar' dialog (CONTRACTS §18): name + curated palette swatch row
 * (design.md §9.3) → MKCOL a VEVENT calendar at /<user>/<slug>.ics/ beside
 * the account's existing calendars, then engine `relistAccount` adopts it
 * into the sync registry and repushes the collection union to the store.
 */
import { useEffect, useState } from 'preact/hooks';
import { Modal } from '../../ui/Modal';
import { bumpDialogClose, bumpDialogOpen } from '../../stores/ui';
import { PALETTE } from '../../lib/util/colors';
import { accounts } from '../../stores/accounts';
import { collections } from '../../stores/calendars';
import { push } from '../../stores/toasts';
import type { DavAccount } from '../../lib/caldav/types';
import { clientForAccount } from '../../lib/sync/discovery';
import { relistAccount } from '../../lib/sync/engine';

/**
 * The §9.3 swatch row, shared with CalSettingsPopover. Chips read
 * `--chip-color`; the selected ring + check glyph and the 'none' slash are
 * drawn by CSS (.swatch / .swatch-selected / .swatch-none — no icon markup).
 */
export function SwatchRow(props: {
  /** Selected hex, or null when the optional 'none' slot is selected. */
  selected: string | null;
  /** When set, renders the leading slash chip labelled with this text. */
  noneLabel?: string;
  onPick: (hex: string | null) => void;
}) {
  return (
    <div class="flex flex-wrap gap-1.5">
      {props.noneLabel !== undefined && (
        <button
          type="button"
          class={`swatch swatch-none${props.selected === null ? ' swatch-selected' : ''}`}
          style={{ '--chip-color': 'var(--surface-3)' }}
          title={props.noneLabel}
          aria-label={props.noneLabel}
          aria-pressed={props.selected === null}
          onClick={() => props.onPick(null)}
        />
      )}
      {PALETTE.map((p) => {
        const isSelected =
          props.selected !== null && props.selected.toLowerCase() === p.hex.toLowerCase();
        return (
          <button
            key={p.hex}
            type="button"
            class={`swatch${isSelected ? ' swatch-selected' : ''}`}
            style={{ '--chip-color': p.hex }}
            title={p.name}
            aria-label={p.name}
            aria-pressed={isSelected}
            onClick={() => props.onPick(p.hex)}
          />
        );
      })}
    </div>
  );
}

/** Request base mirroring CaldavClient's proxy law (page origin + '/dav'). */
function accountRequestBase(account: DavAccount): string {
  let origin: URL;
  try {
    origin = new URL(account.url);
  } catch {
    return account.url.replace(/\/+$/, '');
  }
  const path = origin.pathname.replace(/\/+$/, '');
  const proxied = path === '/dav' || path.startsWith('/dav/');
  return proxied ? `${location.origin}/dav` : origin.origin + path;
}

/** Directory (with trailing slash) that sibling collections live in. */
function parentDirOf(collectionUrl: string): string {
  const stripped = collectionUrl.replace(/\/+$/, '');
  return stripped.slice(0, stripped.lastIndexOf('/') + 1);
}

/** 'Team & Family 2' → 'team-family-2'; falls back to 'calendar'. */
function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'calendar';
}

/**
 * Where the new calendar goes: the account owning the first listed calendar
 * (its URL dir keeps /<user>/ intact), else the first account whose calendar
 * home is discovered at create time. Error when nothing is possible.
 */
function pickTarget(): { account: DavAccount; dirUrl: string } | { error: string } {
  for (const cal of collections.value) {
    if (cal.kind !== 'calendar') continue;
    const account = accounts.value.find((a) => cal.url.startsWith(accountRequestBase(a) + '/'));
    if (account) return { account, dirUrl: parentDirOf(cal.url) };
  }
  const account = accounts.value[0];
  if (!account) return { error: 'No account connected — add one in Settings first.' };
  return { account, dirUrl: '' };
}

export function NewCalendarModal(props: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(PALETTE[0]?.hex ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Register with the global dialog gate (stores/ui) while open, so the
  // global shortcut handler (app.tsx, CONTRACTS §16) is suppressed.
  useEffect(() => {
    if (!props.open) return;
    bumpDialogOpen();
    return bumpDialogClose;
  }, [props.open]);

  const target = props.open ? pickTarget() : null;
  const trimmed = name.trim();

  const create = async (): Promise<void> => {
    if (target === null || !('account' in target) || trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const client = clientForAccount(target.account); // throws when locked
      let dirUrl = target.dirUrl;
      if (dirUrl === '') {
        // No calendars yet — an engine round discovers the calendar home and
        // adopts the account's collections (provisioning included).
        await relistAccount(target.account);
        const home = collections.value.find(
          (c) => c.kind === 'calendar' && c.url.startsWith(accountRequestBase(target.account) + '/'),
        );
        if (!home) throw new Error('Account exposes no calendar home set');
        dirUrl = parentDirOf(home.url);
      }
      // Existing collections keep the Radicale convention <slug>.ics; dedupe.
      const taken = new Set(collections.value.map((c) => c.url.replace(/\/+$/, '')));
      const slug = slugify(trimmed);
      let url = `${dirUrl}${slug}.ics/`;
      for (let n = 2; taken.has(url.replace(/\/+$/, '')); n++) url = `${dirUrl}${slug}-${n}.ics/`;
      await client.mkcol(url, { name: trimmed, kind: 'calendar', color: color || undefined });
      // Engine re-list: adopts the new collection into the sync registry and
      // repushes the union — a direct registerCollections would leave it unsynced.
      await relistAccount(target.account);
      push('success', `Calendar “${trimmed}” created`);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button type="button" class="btn" disabled={busy} onClick={props.onClose}>
        Cancel
      </button>
      <button
        type="submit"
        form="new-calendar-form"
        class="btn btn-primary"
        disabled={busy || trimmed.length === 0 || target === null || !('account' in target)}
      >
        {busy ? 'Creating…' : 'Create calendar'}
      </button>
    </>
  );

  return (
    <Modal open={props.open} title="New calendar" onClose={props.onClose} width={360} footer={footer}>
      <form
        id="new-calendar-form"
        class="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter = Create (button is outside the form element).
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (!busy) void create();
          }
        }}
      >
        <label class="flex flex-col gap-1 text-xs text-muted">
          Name
          <input
            class="input"
            value={name}
            placeholder="e.g. Personal"
            disabled={busy}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <div class="flex flex-col gap-1 text-xs text-muted">
          Color
          <SwatchRow selected={color} onPick={(hex) => setColor(hex ?? '')} />
        </div>
        {target !== null && 'account' in target && (
          <p class="text-xs text-muted">Created in {target.account.username}'s account</p>
        )}
        {target !== null && 'error' in target && <p class="text-xs text-danger">{target.error}</p>}
        {error !== null && (
          <p class="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
