import {
  SESSION_KEYS,
  type EditorSessionState,
  type SessionKey,
} from "@replit-clone/shared";
import { getEditorSessionApi, setEditorSessionApi } from "../apis/projects.ts";
import { useEditorSettingsStore } from "../store/editorSettingsStore.ts";
import { useKeybindingStore } from "../store/keybindingStore.ts";
import { useThemeStore } from "../store/themeStore.ts";
import { useWorkspaceStore } from "../store/workspaceStore.ts";

/** A session that follows the person rather than the browser. plan.md §13.11.
 *
 *  **What was wrong.** Four stores persisted to `localStorage`, which is per
 *  browser. Opening the same workspace from a second machine — the *reason*
 *  the workspace is on a server — gave a blank editor, default settings, and
 *  none of the keybindings somebody had spent a month building.
 *
 *  **Why `localStorage` is still here rather than replaced.** It is the local
 *  cache and it stays authoritative for first paint. Making the endpoint the
 *  storage would mean an async `persist`, which means the editor renders with
 *  defaults for one frame and then jumps — and it would mean a signed-out or
 *  offline browser having no settings at all, which is worse than what we
 *  started with. So: `localStorage` for what this browser had, the endpoint
 *  for what this person had, reconciled once at sign-in.
 *
 *  **Pull once, push on change.** A pull at sign-in, and a debounced push
 *  whenever a store changes. No polling: nothing here changes without somebody
 *  changing it, and a second machine's tab is already going to reload before
 *  it matters.
 *
 *  **The one rule worth stating.** A key changed on THIS machine since the
 *  page loaded is never overwritten by the pull. Without that, somebody who
 *  drags a divider in the second before a slow pull returns watches it snap
 *  back, which reads as the app fighting them — and they would be right.
 */

interface Persisted {
  getState: () => unknown;
  getInitialState: () => object;
  /** Both overloads, matching zustand's own: a store whose `setState` only
   *  declared the replacing form is not assignable to it. */
  setState: {
    (partial: never, replace?: false): void;
    (state: never, replace: true): void;
  };
  subscribe: (listener: () => void) => () => void;
  persist: {
    rehydrate: () => void | Promise<void>;
  };
}

interface Synced {
  key: SessionKey;
  store: Persisted;
}

/** The stores, paired with the `persist` name each one already writes under.
 *  The name is the contract with `localStorage` and with the server both, so
 *  it is taken from the allowlist rather than retyped. */
const SYNCED: Synced[] = [
  { key: "rc-editor-settings", store: useEditorSettingsStore },
  { key: "rc-keybindings", store: useKeybindingStore },
  { key: "rc-workspace", store: useWorkspaceStore },
  { key: "rc-theme", store: useThemeStore },
];

/** How long a burst of changes is allowed to settle before it is sent.
 *
 *  Dragging a divider fires a change per animation frame. Sending each one is
 *  a request per frame for a number nobody will read until the next sign-in. */
const PUSH_DELAY_MS = 1200;

/** Revisions this browser has already seen, so a pull that would hand back a
 *  value we ourselves wrote is skipped rather than fed through the store. */
const REV_KEY = "rc-session-revs";

/** Which account this browser's stored session belongs to.
 *
 *  Two people share a laptop more often than anybody designing this would
 *  like. Without a marker, the second person to sign in sees the first
 *  person's tabs for every key their own account has nothing stored for — and,
 *  worse, the adopt step below would then upload the first person's layout
 *  into the second person's account. */
const ACCOUNT_KEY = "rc-session-account";

function storedAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Set while a pulled value is being written in. The store's own subscriber
 *  fires during it, and without this the very act of accepting the server's
 *  value would mark the key dirty and push it straight back. */
let applying = false;

/** Keys changed on this machine since the page loaded. */
const dirty = new Set<SessionKey>();

/** Keys waiting to be sent. */
const pending = new Set<SessionKey>();

/** Resolved once the first pull of this sign-in has finished, however it
 *  finished.
 *
 *  A project page restores its tab layout from the store once, at open. On a
 *  machine that has never opened this project there is nothing in
 *  `localStorage` to restore, and the account's layout is still in flight — so
 *  without something to wait on, whether the second machine comes back to your
 *  tabs depends on which of two network round trips wins. Bounded by the
 *  caller, because a browser that is offline must still open the project. */
let settle: (() => void) | null = null;
let settled: Promise<void> = Promise.resolve();

let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribes: (() => void)[] = [];
let running = false;

function readLocal(key: SessionKey): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    // Private mode, a quota error, or a value some other tab corrupted. None
    // of them are a reason to stop the editor.
    return null;
  }
}

function writeLocal(key: SessionKey, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do and nothing worth saying: the store still holds the value
    // in memory, and this browser simply will not remember it.
  }
}

function seenRevs(): Partial<Record<SessionKey, number>> {
  try {
    const raw = localStorage.getItem(REV_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Partial<Record<SessionKey, number>>);
  } catch {
    return {};
  }
}

function rememberRev(key: SessionKey, rev: number): void {
  const revs = seenRevs();
  revs[key] = rev;
  try {
    localStorage.setItem(REV_KEY, JSON.stringify(revs));
  } catch {
    // See writeLocal. A forgotten revision costs one redundant pull.
  }
}

/** Forgets which revisions this browser has seen.
 *
 *  Called when the account changes, and it matters: revisions are per account,
 *  and a browser that carried the previous account's numbers would decide the
 *  new account's stored session was one it had already applied. */
export function forgetSeenRevs(): void {
  try {
    localStorage.removeItem(REV_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Then the worst case is one skipped pull for one key.
  }
}

/** Writes a pulled value into `localStorage` and re-reads it through the
 *  store, which is how zustand's `persist` is designed to be reloaded. Going
 *  through storage rather than `setState` keeps one code path for versioning
 *  and `partialize`, so a store that grows a migration gets it here for free. */
async function apply(entry: Synced, value: unknown): Promise<void> {
  applying = true;
  try {
    writeLocal(entry.key, value);
    await entry.store.persist.rehydrate();
  } finally {
    applying = false;
  }
}

/** Takes the server's session where this browser has not already diverged. */
/** Waits for the first pull, or for `timeoutMs`, whichever comes first.
 *
 *  Resolves immediately when nothing is syncing — signed out, an embed, or a
 *  deployment whose server does not have the endpoint. Waiting in those cases
 *  would be a delay on every project open in exchange for nothing. */
export function whenSessionSettled(timeoutMs = 3000): Promise<void> {
  if (!running) return Promise.resolve();

  return Promise.race([
    settled,
    new Promise<void>((resolve) => {
      const id = setTimeout(resolve, timeoutMs);
      // Node's timer keeps a test process alive otherwise; the browser has no
      // `unref` and does not need one.
      (id as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

export async function pullSession(): Promise<void> {
  let state: EditorSessionState;
  try {
    state = await getEditorSessionApi();
  } catch {
    // Signed out, offline, or an older server without the endpoint. The
    // browser keeps what it has, which is exactly the behaviour before §13.11.
    return;
  }

  const revs = seenRevs();

  for (const entry of SYNCED) {
    const stored = state.entries[entry.key];
    if (!stored) continue;

    // Changed here since the page loaded. Somebody is using this machine right
    // now, and their change is newer than anything a pull can know about.
    if (dirty.has(entry.key)) continue;

    // Our own last write coming back. Re-applying it is not wrong, only a
    // pointless re-render of every component subscribed to the store.
    if (revs[entry.key] === stored.rev) continue;

    await apply(entry, stored.value);
    rememberRev(entry.key, stored.rev);
  }

  // Anything this browser has that the account does not. Without this the
  // FIRST machine never uploads: it changes nothing after signing in, so
  // nothing is ever pushed, and the second machine finds an empty account and
  // concludes the person has no settings.
  //
  // Only where the account has nothing at all for that key, so this can never
  // overwrite what another machine stored -- and only for this account's own
  // browser state, which `startSessionSync` has already made true by clearing
  // somebody else's before the pull.
  for (const entry of SYNCED) {
    if (state.entries[entry.key]) continue;
    if (readLocal(entry.key) === null) continue;
    schedule(entry.key);
  }
}

/** Drops another account's session out of this browser.
 *
 *  Two people share a laptop. Signing in as the second one must not show the
 *  first one's tabs, and must certainly not upload them. Both halves matter:
 *  the stored copy, and the copy already live in memory from before the
 *  switch. */
function clearForeignSession(): void {
  applying = true;
  try {
    for (const entry of SYNCED) {
      // `rehydrate` cannot do this: with nothing stored it leaves the live
      // state exactly as it is, which here is the previous account's.
      entry.store.setState(entry.store.getInitialState() as never, true);

      // AFTER the reset, not before. `persist` writes on every setState, so
      // clearing storage first only means the reset immediately writes the
      // defaults back -- and the adopt step would then upload one person's
      // defaults into the other person's empty account.
      try {
        localStorage.removeItem(entry.key);
      } catch {
        // Then the store is still reset, which is the half that shows.
      }
    }
  } finally {
    applying = false;
  }
  forgetSeenRevs();
}

async function flush(): Promise<void> {
  if (pending.size === 0) return;

  const keys = [...pending];
  pending.clear();

  const entries: Partial<Record<SessionKey, unknown>> = {};
  for (const key of keys) entries[key] = readLocal(key);

  try {
    const state = await setEditorSessionApi(entries);
    for (const key of keys) {
      const rev = state.entries[key]?.rev;
      if (rev !== undefined) rememberRev(key, rev);
    }
  } catch {
    // Left out of `pending` deliberately rather than retried: the next change
    // to the same key sends the whole value again, so one failed save costs
    // nothing beyond itself, and a retry loop against a server that is down is
    // a request every second for as long as the tab is open.
  }
}

function schedule(key: SessionKey): void {
  pending.add(key);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, PUSH_DELAY_MS);
}

/** Starts syncing. Idempotent, because React's StrictMode mounts twice and two
 *  subscriptions would be two pushes for one change. */
export function startSessionSync(userId: string): void {
  if (running) return;
  running = true;

  if (storedAccount() !== null && storedAccount() !== userId) {
    clearForeignSession();
  }
  try {
    localStorage.setItem(ACCOUNT_KEY, userId);
  } catch {
    // Then the next sign-in treats this browser as one that has never synced,
    // which is the cautious direction: it pulls, and it adopts only what the
    // account has nothing for.
  }

  for (const entry of SYNCED) {
    unsubscribes.push(
      entry.store.subscribe(() => {
        if (applying) return;
        dirty.add(entry.key);
        schedule(entry.key);
      }),
    );
  }

  // A tab being hidden or closed is the moment somebody's last change is most
  // likely to be sitting in the debounce window.
  const onHide = (): void => {
    if (document.visibilityState === "hidden") void flush();
  };
  const onUnload = (): void => {
    void flush();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onUnload);
  unsubscribes.push(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onUnload);
  });

  settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  void pullSession().finally(() => {
    settle?.();
    settle = null;
  });
}

export function stopSessionSync(): void {
  for (const off of unsubscribes) off();
  unsubscribes = [];
  if (timer) clearTimeout(timer);
  timer = null;
  pending.clear();
  dirty.clear();
  running = false;

  // Anything waiting on the first pull must not wait on a sync that is no
  // longer happening.
  settle?.();
  settle = null;
  settled = Promise.resolve();
}

/** Test seam. The module holds process-wide state on purpose — there is one
 *  browser and one signed-in account — and a test suite needs to be able to
 *  put it back. */
export function resetSessionSyncForTests(): void {
  stopSessionSync();
  applying = false;
}

export const SYNCED_KEYS: readonly SessionKey[] = SESSION_KEYS;
