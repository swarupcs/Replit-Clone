import type { RunStatus } from "@replit-clone/shared";

/** Deciding what a project's run really is, from what can be observed.
 *
 *  The run state is bookkeeping in one Node process. The dev server is a
 *  process group inside a container, and the container is Docker's. All three
 *  outlive each other in different combinations, so the bookkeeping goes wrong
 *  routinely rather than exceptionally:
 *
 *  - restart the server and every running project reads as idle;
 *  - the idle reaper reclaims a container and the run inside it goes with it;
 *  - the run's process dies while its exec STREAM stays open, so the handler
 *    that would have recorded the exit never fires and the state says
 *    `running` for ever.
 *
 *  That last one is the one that wedges a project: `running` blocks the
 *  adoption path (nothing to adopt — it thinks it already has it) and blocks
 *  the automatic start (something is already going), so no number of reloads
 *  can put it right and the user has to press Stop and then Run.
 *
 *  Rather than one special case per cause, this asks what is true now. It is
 *  separate from the runner because these rules are the interesting part, and
 *  what surrounds them there is Docker plumbing.
 */
export interface RunReality {
  /** What the bookkeeping currently claims. */
  status: RunStatus;
  /** Docker's answer for the exec this process started, or undefined when it
   *  started none (or the exec has already been cleared).
   *
   *  Deliberately not "do we hold an exec object": holding one proves only that
   *  a run was started, which is exactly the belief that goes stale. Only
   *  Docker knows whether that process is still alive. */
  execRunning?: boolean;
  /** Whether the process group the run recorded inside the container is still
   *  alive.
   *
   *  The answer for a run this process did not start, and the one that makes
   *  an INSTALLING run recognisable. `execRunning` covers a run we hold the
   *  exec for; after a server restart we hold nothing, and a project part-way
   *  through `npm install` is not listening either — so it read as a project
   *  that had never been started, and opening it launched a second install
   *  into the same directory as the first. */
  processGroupAlive?: boolean;
  /** Whether the project has a container that is up. */
  containerRunning: boolean;
  /** Whether something accepts connections on the template's dev port. */
  listening: boolean;
}

export type Reconciliation =
  /** The bookkeeping agrees with the world; leave it alone. */
  | "none"
  /** A dev server is serving that this process knows nothing about. Take it
   *  over, so it is neither reported as stopped nor started a second time. */
  | "adopt"
  /** The container went away underneath the run — the idle reaper, most often.
   *  Nothing about the user's code went wrong, so this is a project waiting to
   *  be resumed rather than a failure to look at. */
  | "reclaimed"
  /** The state claims a run that nothing can be found of. */
  | "lost";

/** Works out what the run actually is.
 *
 *  Two distinctions carry the whole thing:
 *
 *  - A dev server that EXITED versus a container that was TAKEN AWAY. Both
 *    leave nothing running, and treating both as a crash means a container
 *    reclaimed while its owner was at lunch comes back as "Exited" needing a
 *    button press. The container still being up separates them: a dev server
 *    that dies takes only its own process group with it.
 *  - Nothing listening YET versus nothing listening ANY MORE. A run in
 *    `starting` has nothing listening by definition — `npm install` takes a
 *    while — so the live process is what tells the two apart, and it must come
 *    from Docker rather than from this process's own memory. Either witness
 *    will do: the exec, while we still hold one, or the process group the run
 *    recorded in the container, which is all that is left after a restart.
 */
export function reconcileDecision({
  status,
  execRunning,
  processGroupAlive,
  containerRunning,
  listening,
}: RunReality): Reconciliation {
  // Something is serving. That settles it whatever anything else says.
  if (listening) return status === "running" ? "none" : "adopt";

  // A run whose process Docker still reports as alive is mid-flight: it is
  // installing, or building, or is a command that never listens at all.
  if (execRunning === true) return "none";

  // The same thing, for a run this process did not start. Nothing is serving
  // yet, but something is plainly working towards it — so this is a run to
  // take over and report the progress of, not an absence to fill by starting
  // a second one beside it.
  if (processGroupAlive === true) {
    // Already accounted for. A dev server that stops answering for a moment —
    // restarting itself after a config change, rebuilding — would otherwise
    // flap the badge back to "starting" and replay its log every time somebody
    // opened the project. The wedge this whole function exists for is the
    // opposite case, and it is still caught below: nothing serving and nothing
    // alive.
    if (status === "starting" || status === "running") return "none";
    return "adopt";
  }

  switch (status) {
    case "starting":
    case "running":
      return "lost";

    case "exited":
      // Its container went with it, so what ended it was the platform, not the
      // code. With the container still up, the dev server really did exit and
      // is worth looking at rather than restarting into the same failure.
      return containerRunning ? "none" : "reclaimed";

    case "idle":
      return "none";
  }
}

/** Whether a reconciliation leaves the project free to start itself again.
 *
 *  A run that stopped because the platform took it away is one the user never
 *  ended, so opening the project should bring it back — that is most of what
 *  separates a hosted environment from a laptop. An explicit Stop is remembered
 *  separately and still outranks this.
 */
export function isResumable(decision: Reconciliation): boolean {
  return decision === "reclaimed" || decision === "lost";
}
