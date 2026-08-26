/** Dependency management, for projects whose users should not have to open a
 *  terminal to add a library.
 *
 *  Three ecosystems, because the twelve templates only span three: npm for the
 *  Node/React/Next/Vue/Svelte ones, pip for the two Python ones, and Go
 *  modules for the last. A template with no manifest at all (Static HTML) has
 *  no ecosystem and says so, rather than being shown an empty npm list it can
 *  never add to.
 */

/** Which package manager owns this project, decided by the manifest on disk. */
export type Ecosystem = "npm" | "pip" | "go";

/** The file that is the source of truth for each ecosystem's dependencies. */
export const MANIFEST_BY_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "package.json",
  pip: "requirements.txt",
  go: "go.mod",
};

export interface PackageEntry {
  name: string;
  /** Exactly as the manifest writes it — "^18.2.0", ">=2.0", "v1.9.0". Not
   *  normalised, because the range is a decision the user made and rewriting it
   *  in a list they are only reading would be a lie about what is pinned. */
  version: string;
  /** npm's devDependencies, and nothing else — pip and Go do not draw this
   *  distinction in the manifests these templates ship. */
  dev?: boolean;
}

export interface PackageList {
  /** Null when the project has no manifest, i.e. no ecosystem to manage. */
  ecosystem: Ecosystem | null;
  /** The manifest the entries were read from, for the UI to name. */
  manifest: string | null;
  packages: PackageEntry[];
}

/** Longest a dependency name may be.
 *
 *  npm's own limit is 214; the others are shorter. One ceiling for all three is
 *  enough, since the point is to bound the argument, not to validate it. */
export const MAX_PACKAGE_NAME = 214;

/** Longest a version specifier may be — ranges like ">=1.2,<2" are short, and
 *  anything long is a URL or a git ref, which this deliberately does not
 *  accept. */
export const MAX_PACKAGE_VERSION = 64;

/** GET /api/v1/projects/:projectId/packages */
export type ListPackagesResponse = {
  success: true;
  message: string;
  data: PackageList;
};
