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
}
