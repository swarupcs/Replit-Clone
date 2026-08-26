/** Publishing a project's build output to a public origin.
 *
 *  The preview proxy shows a *dev* server to somebody who already has a
 *  session, behind a container that is stopped once it goes idle. A deployment
 *  is the opposite of all three: a build rather than a dev server, no session
 *  required, and no container behind it at all once the files are copied out.
 *  That is what makes a link shareable with somebody who has never heard of
 *  this platform.
 */

export type DeploymentStatus = "building" | "live" | "failed";

/** What a project's deployment looks like to the editor. */
export interface Deployment {
  status: DeploymentStatus;
  /** The generated subdomain label, e.g. "quiet-fern-84f1". */
  subdomain: string;
  /** Absolute, public, and unauthenticated. Null while the first build of a
   *  never-yet-published project is still running. */
  url: string | null;
  /** The command that produced it, and the directory it read afterwards.
   *  Recorded per deployment rather than looked up, so a template's defaults
   *  changing does not rewrite the history of what actually ran. */
  buildCommand: string;
  outputDir: string;
  /** Total bytes published. */
  sizeBytes: number;
  /** Tail of the build's own output, so a failure can be read where it
   *  happened rather than only in the terminal. */
  log: string;
  /** Why the last attempt failed, or null. */
  error: string | null;
  /** ISO timestamp of the last build that went live, or null if none has. */
  deployedAt: string | null;
}

/** Whether a project CAN be deployed statically, worked out from its template.
 *
 *  Sent to the editor so the panel can explain the answer up front instead of
 *  offering a button that always fails.
 */
export interface DeployTarget {
  deployable: boolean;
  /** Present when `deployable` is false: the reason, in the user's terms. */
  reason?: string;
  /** The build command that would run, or "" for a template with no build
   *  step at all (static HTML is already its own output). */
  buildCommand: string;
  /** Directory, relative to the project root, published afterwards. */
  outputDir: string;
}

/** Everything the deployment panel needs in one request. */
export interface DeploymentState {
  target: DeployTarget;
  deployment: Deployment | null;
}

/** A DNS label: at most 63 characters, and the only characters a hostname may
 *  carry. Enforced on the way in AND on the way out, because this value becomes
 *  both a hostname and a directory name. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_SUBDOMAIN = 63;
