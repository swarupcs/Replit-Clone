/** Where the editor was left, against the account rather than the browser.
 *  plan.md §13.11.
 *
 *  The stores holding this already persisted -- to `localStorage`, which is
 *  per browser. Opening the same workspace from a second machine is the
 *  *reason* the workspace is on a server, and it gave a blank editor with
 *  default settings. These types are the endpoint those same stores now write
 *  through.
 */

/** The stores allowed to sync, by their zustand `persist` name.
 *
 *  An allowlist rather than an open key space, because the alternative is a
 *  table any browser can write anything into, keyed by whatever it likes. Each
 *  entry is here because the thing it holds follows the PERSON:
 *
 *  - `rc-editor-settings` — sixteen preferences, none of them per-machine.
 *  - `rc-keybindings` — chord overrides; muscle memory is not per browser.
 *  - `rc-workspace` — open tabs, expanded folders, pane sizes, per project.
 *  - `rc-theme` — the one choice somebody notices within a second of opening
 *    a second machine.
 *
 *  Deliberately absent: `rc-ai-chat`, which is a conversation rather than a
 *  layout and would put prompts into a table this row has no business
 *  enlarging.
 */
export const SESSION_KEYS = [
  "rc-editor-settings",
  "rc-keybindings",
  "rc-workspace",
  "rc-theme",
] as const;

export type SessionKey = (typeof SESSION_KEYS)[number];

export function isSessionKey(value: unknown): value is SessionKey {
  return (
    typeof value === "string" && (SESSION_KEYS as readonly string[]).includes(value)
  );
}

/** One stored store, as the API returns it. */
export interface SessionEntry {
  /** Whatever the store persisted, verbatim. Opaque to the server: the shape
   *  belongs to the client that wrote it, and a server validating today's
   *  shape would reject a client one version ahead of it. */
  value: unknown;

  /** Bumped by the server on every write. A client keeps the revision it last
   *  saw so it can skip a pull that would hand it back its own value. */
  rev: number;

  updatedAt: string;
}

/** Everything this account has stored. One round trip, because a boot needs
 *  all of it and four requests to answer one question is three too many. */
export interface EditorSessionState {
  entries: Partial<Record<SessionKey, SessionEntry>>;
}

/** What a client sends. Only the keys it is changing -- an absent key is left
 *  alone, which is what makes it safe for two machines editing different
 *  things to both be right. */
export interface EditorSessionUpdate {
  entries: Partial<Record<SessionKey, unknown>>;
}

/** Cap on one stored value, serialized. `rc-workspace` is the only one that
 *  grows with use (25 projects, each with its open paths and expanded
 *  folders), and 128 KB is far above what that reaches while still being a
 *  number that stops a loop from filling a table. */
export const MAX_SESSION_VALUE_BYTES = 128 * 1024;
