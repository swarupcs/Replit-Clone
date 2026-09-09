/** Names a terminal so a reconnect reaches the shell it already had.
 *
 *  plan.md §13.7. The server keeps a detached terminal's shell alive for a
 *  grace window, and a client that cannot say WHICH terminal it is coming back
 *  to gets a new one anyway — so the key is the whole of the client's half of
 *  that feature.
 *
 *  **Why `sessionStorage` and not `localStorage`.** The key must survive a
 *  reload of this tab, because that is the case it exists for: a laptop woken
 *  up, a tab the browser discarded and restored, an accidental refresh. It
 *  must NOT be shared with another tab — two tabs on one project would both
 *  claim the same shell, and the second would take the pty from the first
 *  (`attachSocket` closes the loser with 4001). `sessionStorage` is scoped to
 *  exactly that: one tab, across reloads.
 *
 *  **What "forgetting" means.** Deleting a key is how the client says the user
 *  closed this terminal on purpose rather than losing it — see
 *  `BrowserTerminal`, which reads that as its signal to end the session on the
 *  server instead of letting it linger for a grace window nobody wants.
 */

const PREFIX = "rc-term-session";

/** A per-tab fallback for a browser that refuses storage — a private window,
 *  site data blocked, an embedded frame with third-party storage denied.
 *  Reconnection then works for as long as the page lives, which is still the
 *  common case (a dropped socket) and not the reload case. Degrading is the
 *  right answer: refusing to open a terminal because it cannot be named would
 *  trade a working feature for a missing one. */
const fallback = new Map<string, string>();

function storageKey(projectId: string, tabId: number): string {
  return `${PREFIX}:${projectId}:${String(tabId)}`;
}

function readStored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return fallback.get(key) ?? null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    fallback.set(key, value);
  }
}

/** A key the server will accept: `[A-Za-z0-9_-]{8,64}`, per `isValidClientKey`.
 *
 *  `randomUUID` is unavailable on an insecure origin, which a LAN deployment
 *  reached over plain http is — and the server does not care that this is
 *  random, only that it is distinct and well-formed. */
function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** This tab's key for one terminal, minted on first use and stable after. */
export function terminalSessionKey(projectId: string, tabId: number): string {
  const key = storageKey(projectId, tabId);

  const existing = readStored(key);
  if (existing) return existing;

  const created = newKey();
  writeStored(key, created);
  return created;
}

/** Whether this terminal is still one the user expects to come back to. */
export function hasTerminalSession(projectId: string, tabId: number): boolean {
  return readStored(storageKey(projectId, tabId)) !== null;
}

/** The user closed this terminal. Called before the pane unmounts, so the
 *  component's own teardown can tell a deliberate close from a lost one. */
export function forgetTerminalSession(projectId: string, tabId: number): void {
  const key = storageKey(projectId, tabId);
  fallback.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing stored to remove.
  }
}
