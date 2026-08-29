/** Publishing a project to a public origin.
 *
 *  The preview proxy shows a *dev* server to somebody who already has a
 *  session, behind a container that is stopped once it goes idle. A deployment
 *  drops all three: a build rather than a dev server, no session required, and
 *  a lifetime that does not end when the author closes the tab. That is what
 *  makes a link shareable with somebody who has never heard of this platform.
 *
 *  There are two shapes of it, because projects come in two shapes:
 *
 *  - **static** — the build emits a directory of files, which are copied out
 *    and served with no container behind them at all. Cheap, and the right
 *    answer whenever it is available.
 *  - **service** — the project answers requests from a running process, so
 *    there is nothing to copy. A container of its own stays up and the public
 *    origin reverse-proxies to it. This costs memory for as long as it is
 *    published, which is why it is not the default for anything that could be
 *    static.
 */

export type DeploymentStatus = "building" | "live" | "failed";

/** Which of the two mechanisms above a deployment uses.
 *
 *  Recorded on the deployment rather than derived from the template at read
 *  time, for the same reason `buildCommand` is: a template gaining a static
 *  build later must not silently change what an already-published site claims
 *  to be, nor how it is served.
 */
export type DeploymentKind = "static" | "service";

/** What a project's deployment looks like to the editor. */
export interface Deployment {
  status: DeploymentStatus;
  /** Static files, or a running container. */
  kind: DeploymentKind;
  /** The generated subdomain label, e.g. "quiet-fern-84f1". */
  subdomain: string;
  /** Absolute, public, and unauthenticated. Null while the first build of a
   *  never-yet-published project is still running. */
  url: string | null;
  /** The command that produced it, and the directory it read afterwards.
   *  Recorded per deployment rather than looked up, so a template's defaults
   *  changing does not rewrite the history of what actually ran.
   *
   *  For a service deployment `outputDir` is empty: nothing is read back,
   *  because the command does not terminate. */
  buildCommand: string;
  outputDir: string;
  /** The container port a service deployment is proxied to, or null for a
   *  static one. */
  port: number | null;
  /** Total bytes published. For a service, the size of the copied source
   *  tree rather than of a build output. */
  sizeBytes: number;
  /** Tail of the build's own output, so a failure can be read where it
   *  happened rather than only in the terminal. */
  log: string;
  /** Why the last attempt failed, or null. */
  error: string | null;
  /** ISO timestamp of the last build that went live, or null if none has. */
  deployedAt: string | null;
}

/** How a project CAN be deployed, worked out from its template.
 *
 *  Sent to the editor so the panel can explain the answer up front instead of
 *  offering a button that always fails.
 */
export interface DeployTarget {
  deployable: boolean;
  /** Which mechanism would be used. Meaningless when `deployable` is false.
   *
   *  Static wins wherever a template offers both, and no template offers
   *  both today: a directory of files needs no container, cannot crash, and
   *  costs nothing to keep published. Service exists for the projects that
   *  have no such directory to offer. */
  kind: DeploymentKind;
  /** Present when `deployable` is false: the reason, in the user's terms. */
  reason?: string;
  /** The command that would run: a build for a static target, the long-lived
   *  serve command for a service one, or "" for a template with no build step
   *  at all (static HTML is already its own output). */
  buildCommand: string;
  /** Directory, relative to the project root, published afterwards. Empty for
   *  a service target, which publishes no directory. */
  outputDir: string;
  /** The container port a service target would be proxied to, or null for a
   *  static one. */
  port: number | null;
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
