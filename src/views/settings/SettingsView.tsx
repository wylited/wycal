/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { prefs, setPrefs } from '@wycal/core/stores/prefs';
import type { Density, FirstDay, SidebarSide, Theme } from '@wycal/core/stores/prefs';
import { accounts, addAccount, removeAccount, setAccountPassword, setRememberPassword } from '@wycal/core/stores/accounts';
import type { DavAccount } from '@wycal/core/lib/caldav/types';
import { initSync, resumeAccount, syncState } from '@wycal/core/lib/sync/engine';
import { push } from '@wycal/core/stores/toasts';
import { Icon } from '../../ui/icons';
import { Segmented } from '../../ui/Segmented';

/**
 * Same-origin /dav proxy path (CONTRACTS §1) — prefilled server URL computed
 * from the page's own origin, so whatever host serves the app (localhost,
 * 127.0.0.1, lan-ip, hostname) stays same-origin through the proxy.
 */
const DEFAULT_SERVER_URL = `${location.origin}/dav`;

/** FullCalendar view names (CONTRACTS §5). */
const VIEW_OPTIONS = [
  { value: 'timeGridDay', label: 'Day' },
  { value: 'timeGridWeek', label: 'Week' },
  { value: 'dayGridTwoWeeks', label: '2 Weeks' },
  { value: 'dayGridMonth', label: 'Month' },
  { value: 'listAgenda', label: 'Agenda' },
] as const;

const DURATION_OPTIONS = [15, 30, 60, 90, 120] as const;

function Section(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-md font-semibold text-fg-strong">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** Visible label above a form control (design.md §5: --text-xs muted 500, 4px gap). */
function Field(props: { label: string; forId?: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-1">
      <label for={props.forId} class="text-xs font-medium text-muted">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

/** Labeled row for button-based controls (segmented) — group + labelledby, not <label>. */
function LabeledGroup(props: { label: string; id: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-1">
      <span id={props.id} class="text-xs font-medium text-muted">
        {props.label}
      </span>
      <div role="group" aria-labelledby={props.id}>
        {props.children}
      </div>
    </div>
  );
}

/** Per-account sync chip (design.md §5): dot + text — 'Synced', pulsing
 *  'Syncing…', or 'Error' (message on hover here and inline in the row). */
function SyncStatus(props: { accountId: string }) {
  const st = syncState.value.get(props.accountId);
  const dot =
    st?.state === 'ok'
      ? 'bg-success'
      : st?.state === 'syncing'
        ? 'animate-pulse bg-warning'
        : st?.state === 'error'
          ? 'bg-danger'
          : 'bg-surface-3';
  const label =
    st?.state === 'ok'
      ? 'Synced'
      : st?.state === 'syncing'
        ? 'Syncing…'
        : st?.state === 'error'
          ? 'Error'
          : 'Not synced';
  return (
    <span
      class="flex items-center gap-2 text-xs text-muted"
      title={st?.state === 'error' && st.message ? st.message : undefined}
    >
      <span class={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function AccountRow(props: { account: DavAccount }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const st = syncState.value.get(props.account.id);

  const unlock = (event: Event) => {
    event.preventDefault();
    if (password === '') return;
    // Stores the secret, then explicitly resumes the account round (discovery
    // + provisioning + initial full sync) so the resume does not depend on
    // signal-effect scheduling. The engine's round lock makes this call and
    // the accounts effect converge on one round — no double sync.
    setAccountPassword(props.account.id, password);
    void resumeAccount(props.account.id);
    setPassword('');
  };

  return (
    <li class="flex items-center gap-3 px-2.5 py-1">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate font-mono text-sm text-fg-strong">{props.account.url}</span>
        <span class="flex items-center gap-3">
          <span class="truncate text-xs text-muted">{props.account.username}</span>
          <SyncStatus accountId={props.account.id} />
        </span>
        {st?.state === 'error' && st.message && (
          <span class="truncate text-xs text-danger" title={st.message}>
            {st.message}
          </span>
        )}
        {props.account.needsPassword && (
          <form class="mt-0.5 flex items-center gap-1.5" onSubmit={unlock}>
            <input
              type="password"
              class="input max-w-48 text-xs"
              placeholder="Password"
              autoComplete="off"
              aria-label={`Password for ${props.account.username}`}
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            <button type="submit" class="btn btn-sm" disabled={password === ''}>
              <Icon.check size={14} />
              Unlock
            </button>
          </form>
        )}
        <label class="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            class="size-3.5 shrink-0 accent-accent"
            checked={props.account.rememberPassword}
            onChange={(e) => setRememberPassword(props.account.id, e.currentTarget.checked)}
          />
          Remember password on this device
        </label>
      </div>
      {confirming ? (
        <span class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="btn btn-danger btn-sm"
            onClick={() => {
              removeAccount(props.account.id);
              push('info', 'Account removed');
            }}
          >
            <Icon.check size={14} />
            Remove
          </button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          class="btn btn-sm text-danger hover:bg-danger-soft"
          onClick={() => setConfirming(true)}
        >
          <Icon.trash size={14} />
          Remove
        </button>
      )}
    </li>
  );
}

function AccountsSection() {
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [touched, setTouched] = useState(false);

  const urlInvalid = touched && url.trim() === '';
  const userInvalid = touched && username.trim() === '';
  const passInvalid = touched && password === '';

  const onSubmit = (event: Event) => {
    event.preventDefault();
    setTouched(true);
    const trimmedUrl = url.trim();
    const trimmedUser = username.trim();
    if (!trimmedUrl || !trimmedUser || !password) return;
    addAccount({ url: trimmedUrl, username: trimmedUser, password, rememberPassword: remember });
    // Idempotent (engine guards re-init): the accounts effect inside kicks off
    // discovery + initial full sync for the new account and updates syncState.
    initSync();
    push('success', 'Account added — syncing…');
    setUsername('');
    setPassword('');
    setRemember(false);
    setTouched(false);
  };

  return (
    <div class="flex flex-col gap-4">
      {accounts.value.length > 0 ? (
        <ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
          {accounts.value.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      ) : (
        <p class="text-sm text-muted">No accounts configured yet.</p>
      )}

      {accounts.value.length === 0 && (
        <button
          type="button"
          class="btn btn-primary btn-sm self-start"
          title="Connect local admin"
          onClick={() => {
            addAccount({ url: DEFAULT_SERVER_URL, username: 'admin', password: 'admin', rememberPassword: false });
            // Idempotent (engine guards re-init): the accounts effect kicks off
            // discovery + initial full sync for the new admin account.
            initSync();
            push('success', 'Account added — syncing…');
          }}
        >
          <Icon.plus size={14} />
          Connect local admin (admin/admin)
        </button>
      )}

      <form class="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        <Field label="Server URL" forId="acct-url">
          <input
            id="acct-url"
            type="url"
            class="input font-mono"
            placeholder={DEFAULT_SERVER_URL}
            value={url}
            aria-invalid={urlInvalid || undefined}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
          {urlInvalid && <span class="text-xs text-danger">Server URL is required.</span>}
        </Field>
        <div class="flex flex-col gap-3 sm:flex-row">
          <Field label="Username" forId="acct-user">
            <input
              id="acct-user"
              type="text"
              class="input"
              autoComplete="off"
              value={username}
              aria-invalid={userInvalid || undefined}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
            {userInvalid && <span class="text-xs text-danger">Username is required.</span>}
          </Field>
          <Field label="Password" forId="acct-pass">
            <input
              id="acct-pass"
              type="password"
              class="input"
              autoComplete="off"
              value={password}
              aria-invalid={passInvalid || undefined}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            {passInvalid && <span class="text-xs text-danger">Password is required.</span>}
          </Field>
        </div>
        <label class="flex items-center gap-2 text-xs text-muted">
          <input
            id="acct-remember"
            type="checkbox"
            class="size-3.5 shrink-0 accent-accent"
            checked={remember}
            onChange={(e) => setRemember(e.currentTarget.checked)}
          />
          Remember password on this device (stored in plain text)
        </label>
        <p class="flex items-start gap-1.5 text-xs text-warning">
          <Icon.alert size={14} class="mt-0.5 shrink-0" />
          <span>
            Passwords stay in this tab's session storage only. Enable Remember to persist them
            (plain text) on this device.
          </span>
        </p>
        <button type="submit" class="btn btn-primary btn-sm self-start">
          <Icon.plus size={14} />
          Add account
        </button>
      </form>
    </div>
  );
}

function AppearanceSection() {
  return (
    <div class="flex flex-col gap-4">
      <LabeledGroup label="Theme" id="pref-theme-label">
        <Segmented<Theme>
          value={prefs.value.theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'auto', label: 'Auto' },
          ]}
          onChange={(theme) => setPrefs({ theme })}
        />
      </LabeledGroup>
      <LabeledGroup label="Density" id="pref-density-label">
        <Segmented<Density>
          value={prefs.value.density}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'cozy', label: 'Cozy' },
          ]}
          onChange={(density) => setPrefs({ density })}
        />
      </LabeledGroup>
      <LabeledGroup label="Sidebar side" id="pref-sidebar-side-label">
        <Segmented<SidebarSide>
          value={prefs.value.sidebarSide}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ]}
          onChange={(sidebarSide) => setPrefs({ sidebarSide })}
        />
      </LabeledGroup>
    </div>
  );
}

function GeneralSection() {
  const view = prefs.value.defaultView;
  const viewKnown = VIEW_OPTIONS.some((option) => option.value === view);
  return (
    <div class="flex flex-col gap-4">
      <Field label="First day of week" forId="pref-firstday">
        <select
          id="pref-firstday"
          class="input"
          value={String(prefs.value.firstDay)}
          onChange={(e) => setPrefs({ firstDay: Number(e.currentTarget.value) as FirstDay })}
        >
          <option value="0">Sunday</option>
          <option value="1">Monday</option>
        </select>
      </Field>
      <LabeledGroup label="Time format" id="pref-hour-label">
        <Segmented<boolean>
          value={prefs.value.hour12}
          options={[
            { value: false, label: '24h' },
            { value: true, label: '12h' },
          ]}
          onChange={(hour12) => setPrefs({ hour12 })}
        />
      </LabeledGroup>
      <Field label="Default event duration" forId="pref-duration">
        <select
          id="pref-duration"
          class="input"
          value={String(prefs.value.defaultDurationMin)}
          onChange={(e) => setPrefs({ defaultDurationMin: Number(e.currentTarget.value) })}
        >
          {DURATION_OPTIONS.map((min) => (
            <option key={min} value={String(min)}>
              {min} min
            </option>
          ))}
        </select>
      </Field>
      <Field label="Default view" forId="pref-view">
        <select
          id="pref-view"
          class="input"
          value={view}
          onChange={(e) => setPrefs({ defaultView: e.currentTarget.value })}
        >
          {VIEW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {!viewKnown && <option value={view}>{view}</option>}
        </select>
      </Field>
    </div>
  );
}

/** Settings pane: accounts, appearance, general preferences (design.md §5). */
export function SettingsView() {
  return (
    <div class="h-full overflow-y-auto">
      <div class="mx-auto flex w-full max-w-xl flex-col gap-8 px-6 py-6">
        <h1 class="text-lg font-semibold text-fg-strong">Settings</h1>
        <Section title="Accounts">
          <AccountsSection />
        </Section>
        <Section title="Appearance">
          <AppearanceSection />
        </Section>
        <Section title="General">
          <GeneralSection />
        </Section>
        <footer class="border-t border-border pt-4 text-xs text-muted">
          wycal — CalDAV/CardDAV frontend · MIT
        </footer>
      </div>
    </div>
  );
}
