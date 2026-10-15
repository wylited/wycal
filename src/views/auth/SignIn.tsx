/** @jsxImportSource preact */
/**
 * First-run sign-in (CONTRACTS §24): shown INSTEAD of the calendar shell while
 * `accounts` is empty — one centered card that adds the first DAV account and
 * hands over to the shell as the initial sync starts. Deliberately simple: no
 * signup, no forgot-password, no auto-submit.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { addAccount, removeAccount } from '@wycal/core/stores/accounts';
import { initSync, syncState } from '@wycal/core/lib/sync/engine';

const DEFAULT_SERVER_URL = `${location.origin}/dav`;
const ERROR_TEXT = 'Could not sign in — check server, username and password';
/** How long to watch the new account's syncState for an error before trusting
 * the shell (its empty state surfaces sync errors from there on, CONTRACTS §19). */
const WATCH_MS = 8000;

/**
 * True while a first-run sign-in is in flight or showing its error. The gate
 * in app.tsx keeps the card mounted until this clears, so the inline error is
 * reachable (the accounts gate alone would unmount the card the moment
 * addAccount lands). Resets on success/timeout — and on reload, which returns
 * errored attempts to the shell's own sync-error UI.
 */
export const signInActive = signal(false);

export function SignIn() {
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(false);
  /** Errored attempt awaiting retry — dropped on resubmit so retries never
   * stack duplicate account rows. */
  const failedAttempt = useRef<string | null>(null);
  const stopWatch = useRef<(() => void) | null>(null);

  useEffect(() => () => stopWatch.current?.(), []);

  // The card is a modal first-run screen: swallow app-global shortcuts
  // (§16 `n`, `/`, `?`…) fired from the body so nothing queues up behind it.
  // Field-targeted keys pass through untouched (app.tsx ignores editables).
  useEffect(() => {
    const swallow = (e: KeyboardEvent): void => {
      const editable =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if (!editable) e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', swallow, true);
    return () => document.removeEventListener('keydown', swallow, true);
  }, []);

  /** Shared submit: add the account, start sync, watch it for ~8s. The shell
   * appears via the app gate when the watch clears (sync 'ok', or a deadline
   * with the account still syncing); an 'error' — whether it arrives during
   * the watch, is already present when it starts, or is there at the deadline
   * — keeps the card with the inline helper and a re-enabled form, so the
   * next submit drops the failed row and runs a real retry. */
  const submit = (nextUrl: string, nextUser: string, nextPass: string, nextRemember: boolean) => {
    const trimmedUrl = nextUrl.trim();
    const trimmedUser = nextUser.trim();
    // Block only in-flight attempts: an error keeps signInActive true (the gate
    // needs it to hold this card up), so `busy` — not the raw signal — gates here.
    if ((signInActive.value && !error) || !trimmedUrl || !trimmedUser || !nextPass) return;
    setError(false); // helper clears the moment a retry starts
    if (failedAttempt.current) removeAccount(failedAttempt.current);
    // Keep the card's fields truthful for a retry (password included — it
    // stays in this tab's session until the attempt succeeds or is dropped).
    setUrl(trimmedUrl);
    setUsername(trimmedUser);
    setPassword(nextPass);
    setRemember(nextRemember);
    const account = addAccount({
      url: trimmedUrl,
      username: trimmedUser,
      password: nextPass,
      rememberPassword: nextRemember,
    });
    // Idempotent (engine guards re-init); its accounts effect kicks off
    // discovery + initial full sync and updates syncState.
    initSync();
    signInActive.value = true;
    let settled = false;
    const stop = (): void => {
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      stopWatch.current = null;
    };
    const check = (): void => {
      if (settled) return;
      const st = syncState.value.get(account.id);
      if (st?.state === 'ok') {
        stop();
        failedAttempt.current = null;
        signInActive.value = false;
      } else if (st?.state === 'error') {
        stop();
        failedAttempt.current = account.id;
        setError(true); // form re-enables; the card stays via signInActive
      }
    };
    const timer = setTimeout(() => {
      stop();
      const st = syncState.value.get(account.id);
      if (st?.state === 'error') {
        // The sync failed inside the watch window: take the same failure
        // path as `check` — signInActive stays true so the card keeps the
        // inline error (and its retry path) up.
        failedAttempt.current = account.id;
        setError(true);
      } else {
        failedAttempt.current = null;
        signInActive.value = false; // 'ok' or still syncing: shell appears
      }
    }, WATCH_MS);
    const unsubscribe = syncState.subscribe(check);
    stopWatch.current = unsubscribe;
    check(); // syncState may already hold ok/error from before we subscribed
  };

  const busy = signInActive.value && !error;

  return (
    <div class="flex h-dvh items-center justify-center overflow-hidden bg-bg p-4 text-fg">
      <div class="card flex w-full max-w-[360px] flex-col gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-lg font-bold">wycal</h1>
          <p class="text-sm text-muted">Sign in to your CalDAV server</p>
        </div>
        <form
          class="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(url, username, password, remember);
          }}
          noValidate
        >
          <div class="flex flex-col gap-1">
            <label for="signin-url" class="text-xs font-medium text-muted">
              Server URL
            </label>
            <input
              id="signin-url"
              type="url"
              class="input font-mono"
              autoComplete="off"
              value={url}
              disabled={busy}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label for="signin-user" class="text-xs font-medium text-muted">
              Username
            </label>
            <input
              id="signin-user"
              type="text"
              class="input"
              autoComplete="off"
              autoFocus
              value={username}
              disabled={busy}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label for="signin-pass" class="text-xs font-medium text-muted">
              Password
            </label>
            <input
              id="signin-pass"
              type="password"
              class="input"
              autoComplete="off"
              value={password}
              disabled={busy}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-0.5">
            <label class="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                class="size-3.5 shrink-0 accent-accent"
                checked={remember}
                disabled={busy}
                onChange={(e) => setRemember(e.currentTarget.checked)}
              />
              Remember password
            </label>
            <p class="text-xs text-muted">Stored in plain text on this device</p>
          </div>
          {error && (
            <p class="text-xs text-danger" aria-live="polite">
              {ERROR_TEXT}
            </p>
          )}
          <button
            type="submit"
            class="btn btn-primary"
            disabled={busy || !username.trim() || !password || !url.trim()}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div class="flex flex-col gap-1 border-t border-border pt-3">
          <button
            type="button"
            class="btn btn-ghost btn-sm text-muted"
            disabled={busy}
            onClick={() => {
              setUrl(DEFAULT_SERVER_URL);
              setUsername('demo');
              setPassword('demo');
              setRemember(false);
              submit(DEFAULT_SERVER_URL, 'demo', 'demo', false);
            }}
          >
            Use the local demo account (demo/demo)
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm text-muted"
            disabled={busy}
            onClick={() => {
              setUrl(DEFAULT_SERVER_URL);
              setUsername('admin');
              setPassword('admin');
              setRemember(false);
              // Mirrors CalendarView connectAdmin (§19): same account, plus
              // this card's error watch.
              submit(DEFAULT_SERVER_URL, 'admin', 'admin', false);
            }}
          >
            Connect local admin
          </button>
        </div>
      </div>
    </div>
  );
}
