/** What makes a container feel like your machine. plan.md §11.9.
 *
 *  Declared here so the account screen and the server cannot drift apart on
 *  what a setting is called or what the API is willing to hand back.
 */

/** One account's personalization, as the API returns it. */
export interface Personalization {
  dotfilesRepo: string | null;
  dotfilesTarget: string | null;
  dotfilesInstall: string | null;

  /** The public half of the signing key, as an `ssh-ed25519 AAAA...` line,
   *  ready to paste into GitHub's signing-keys page. Null when none is set.
   *
   *  Note what is NOT here, in any form: the private key. It goes in and is
   *  never seen again. A shape that cannot carry the secret cannot leak it
   *  through somebody forgetting a `select`. */
  signingKeyPublic: string | null;

  /** Whether a private key is stored at all. Never the key itself. */
  hasSigningKey: boolean;

  /** Whether commits made here are signed. Deliberately separate from a key
   *  existing, so that adding one does not silently change what every future
   *  commit is, and so signing can be turned off without deleting the key. */
  signCommits: boolean;
}

/** A partial update. An absent field is left alone; an empty string or an
 *  explicit `null` clears it.
 *
 *  The two are different requests and the API treats them as different, which
 *  is the only way "clear my dotfiles" and "do not touch my dotfiles" can both
 *  be expressible on one endpoint. */
export interface PersonalizationUpdate {
  dotfilesRepo?: string | null;
  dotfilesTarget?: string | null;
  dotfilesInstall?: string | null;

  /** An OpenSSH private key. WRITE-ONLY: it is never read back, so a client
   *  cannot round-trip this object -- sending back what it was given would
   *  clear the key, which is why an absent field means "leave it alone". */
  signingKey?: string | null;
  signCommits?: boolean;
}

/** Variables that belong to the account rather than to one project.
 *  plan.md §13.8.
 *
 *  The same shape as a project's, deliberately: one validator, one set of
 *  limits, one answer to "is this encrypted at rest". What differs is the
 *  SCOPE and, because of it, what somebody needs to be told — which is why
 *  `sharedProjects` is on the response and is not on a project's.
 */
export interface AccountSecrets {
  /** Names to values, decrypted. Only ever returned to their owner. */
  vars: Record<string, string>;

  /** Whether this server can seal them at all. Said out loud rather than
   *  implied, because a panel that looks identical either way is a panel that
   *  lies on one of the two servers. */
  encryptedAtRest: boolean;

  /** How many of this account's projects somebody else can reach.
   *
   *  These variables go into every container of every project the account
   *  owns, and an editor on a shared project can read a container's
   *  environment. That is what an editor already is; what is new is that one
   *  mistake now reaches every project instead of one. A count is enough to
   *  make the sentence concrete without turning this endpoint into a project
   *  list.
   */
  sharedProjects: number;
}

/** What a client sends to replace them. The whole set, not a patch: a partial
 *  update has no way to express "delete this one", and these are secrets —
 *  the operation somebody most needs to be sure of is removal. */
export interface AccountSecretsUpdate {
  vars: Record<string, string>;
}
