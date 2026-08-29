/** Projects, forks, and the idea of a public one.
 *
 *  Duplicating a project you already have and forking a stranger's are the
 *  same copy with different permission around it, and the difference is the
 *  interesting part: a duplicate carries the environment variables because it
 *  is yours already, and a fork must not, because it is not.
 */

export type ProjectVisibility = "private" | "public";

/** A public project as the gallery sees it.
 *
 *  Deliberately narrow. The full project row carries `envVars` and
 *  `shareToken`, and this list is readable by anybody with an account.
 */
export interface PublicProject {
  id: string;
  name: string;
  /** Template id, so the gallery can show what it was started from. */
  template: string;
  /** ISO 8601. */
  createdAt: string;
  /** The local part of the owner's address, never the whole of it. */
  ownerName: string;
  /** How many copies people have taken. */
  forks: number;
}
