/** Attaching your own editor to a workspace over SSH. plan.md §10.1 Route C,
 *  §14.2's Phase 1b.
 *
 *  The decision this implements: Monaco stays as the browser editor, and the
 *  workspace becomes attachable, so VS Code, Cursor, Zed or `nvim` can open it
 *  directly. The spike in §10.1 established that this reaches 10.6 (debugging)
 *  and 10.7 (extensions) — the two rows Monaco can never reach — for 7 MB of
 *  image and one volume.
 */

/** A public key an account may log in with.
 *
 *  Deliberately NOT the signing key on `Personalization`. That one is a
 *  PRIVATE key the server holds so a container can sign a commit; this is a
 *  PUBLIC key the server hands to a container so a person can log in. Storing
 *  them together would mean one screen where half the fields must never be
 *  read back and half must always be.
 */
export interface SshKey {
  /** The full `ssh-ed25519 AAAA... comment` line, as `ssh-keygen` writes it. */
  line: string;
  /** "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256". Parsed, not asked for. */
  type: string;
  /** Whatever trailed the key, usually `user@machine`. Empty when there was
   *  none — a key with no comment is legal and common. */
  comment: string;
  /** SHA256 fingerprint in OpenSSH's own `SHA256:...` form, so somebody can
   *  compare it against `ssh-keygen -lf` without trusting this screen. */
  fingerprint: string;
}

export interface AccountSshKeys {
  keys: SshKey[];
  /** Whether this deployment will start an sshd in a sandbox at all. Said out
   *  loud, because a panel that accepts keys on a server that ignores them is
   *  a panel that lies. */
  enabled: boolean;
}

export interface AccountSshKeysUpdate {
  /** The whole set. As with account secrets, a patch cannot express "remove
   *  this one", and removing a key that should no longer open your workspaces
   *  is the operation somebody most needs to be certain of. */
  lines: string[];
}

/** How to reach one workspace with your own editor. */
export interface RemoteAccess {
  /** False when the deployment has SSH turned off, when the container is not
   *  running, or when the account has no key. `reason` says which. */
  available: boolean;
  reason?:
    | "disabled"
    | "not-running"
    | "no-key"
    | "no-port"
    | "failed";
  /** The host somebody's client should dial. The server cannot know its own
   *  public name, so this is `SANDBOX_SSH_HOST` when an operator set one and
   *  the request's own hostname otherwise. */
  host?: string;
  port?: number;
  user?: string;
  /** `ssh -p 12345 sandbox@host`, ready to paste. */
  command?: string;
  /** VS Code's own Remote-SSH URI, which opens the folder directly. */
  vscodeUri?: string;
  /** Where the workspace is inside the container, so a client that wants to
   *  open the folder rather than a shell knows what to ask for. */
  folder?: string;
}
