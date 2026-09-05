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
