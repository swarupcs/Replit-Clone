import type { Container } from "dockerode";
import { getTemplate } from "../templates/registry.js";
import { increment } from "../lib/metrics.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { execCapture } from "./execCapture.js";
import { getRunningContainer, runningProjectContainers } from "./containerManager.js";
import {
  dependencyFingerprint,
  installArtefactsPresent,
  readStamp,
  splitStartCommand,
  writeStamp,
} from "./warmStart.js";

/** Doing the install before somebody is waiting for it.
 *
 *  plan.md §12.2. `warmStart` already answers the other half of this — it
 *  skips an install that would have changed nothing — and the half it does not
 *  answer is what happens when the install *would* change something. Pull a
 *  branch that adds a dependency and the next start pays for a full resolution
 *  with a person watching the terminal, even though the machine was idle for
 *  the twenty minutes before it.
 *
 *  So: when the fingerprint has drifted from the stamp and nothing is waiting,
 *  run the install now and stamp it. The next start then takes `warmStart`'s
 *  fast path, and nobody watched anything.
 *
 *  **What this deliberately does not do is start a stopped container.** That
 *  is the genuinely undecided half — it fights the idle reaper, it spends
 *  memory the capacity gate is rationing, and on a plan whose workspaces never
 *  sleep (§11.4) it would leave them running. It is recorded as its own row
 *  rather than guessed at here; see §12.5.
 *
 *  **A prebuild that fails says nothing to anybody**, and that is a decision
 *  rather than an oversight. Nobody asked for this work, so a notification
 *  about it failing converts a saved minute into an interruption — §6 decision
 *  14's argument, one step further. The failure is logged, the stamp is left
 *  alone, and the next real start installs exactly as it would have.
 */

/** How long an install may run before it is abandoned.
 *
 *  Generous, because a cold `npm install` on a large tree genuinely takes
 *  minutes and abandoning one at four is how this feature becomes a thing that
 *  never finishes anything. Nothing is waiting on it either way.
 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** One at a time, across every project.
 *
 *  An install is the most expensive thing this server causes to happen, and
 *  the whole premise here is that it runs when the machine is otherwise quiet.
 *  Several at once would be the opposite — a background task that makes the
 *  foreground slower is worse than no background task.
 */
let running: Promise<unknown> = Promise.resolve();
/** Projects with a prebuild queued or in flight, so a sweep that overlaps the
 *  previous one does not queue the same project twice. */
const queued = new Set<string>();

export function prebuildInFlight(): number {
  return queued.size;
}

/** Whether this project's dependencies have moved since the last install.
 *
 *  Pure of the container except for the stamp, and every failure answers
 *  "nothing to do": a prebuild is an optimisation, and one that guesses wrong
 *  in the other direction would install on a loop.
 */
export async function needsPrebuild(
  projectId: string,
  container: Container,
): Promise<boolean> {
  const fingerprint = await dependencyFingerprint(projectId);
  // No dependency files at all — a static template, say. Nothing to install.
  if (fingerprint === null) return false;

  const stamped = await readStamp(container);

  // Never installed, or installed against different dependencies. Both are
  // work the next start would otherwise do.
  if (stamped !== fingerprint) return true;

  // The stamp matches but the artefacts are gone, which is what deleting
  // `node_modules` looks like — and a user who did that meant it, so the next
  // start would install. Do it now instead.
  return !(await installArtefactsPresent(projectId));
}

/** The install half of this project's start command, or null.
 *
 *  Reuses `splitStartCommand` rather than reimplementing the parse, which
 *  matters more than it looks: that function's allowlist is what stands
 *  between this and running the SERVE half of somebody's command in the
 *  background. A command it cannot take apart with certainty returns null and
 *  nothing is prebuilt.
 */
export async function installStepFor(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { template: true, startCommand: true, deletedAt: true, takenDownAt: true },
  });

  // Not for a project in the trash or under a takedown. Neither is a project
  // anybody is about to open, and doing unasked-for work on one is the shape
  // of a bug rather than a feature.
  if (!project || project.deletedAt || project.takenDownAt) return null;

  const template = getTemplate(project.template);
  const command = project.startCommand?.trim() || template.startCommand;

  return splitStartCommand(command)?.install ?? null;
}

/** Runs one project's install, if it needs one and nothing else is installing.
 *
 *  Never throws. Answers whether anything was actually installed, which is
 *  what the sweep counts and what the tests assert on.
 */
export async function prebuild(projectId: string): Promise<boolean> {
  if (queued.has(projectId)) return false;
  queued.add(projectId);

  const work = running.then(
    () => attempt(projectId),
    () => attempt(projectId),
  );

  // The chain must not break on a rejection, or every later prebuild inherits
  // it -- the same argument the container capacity gate makes.
  running = work.catch(() => undefined);

  try {
    return await work;
  } finally {
    queued.delete(projectId);
  }
}

async function attempt(projectId: string): Promise<boolean> {
  try {
    // Only a container that is already up. Starting one is §12.5.
    const container = await getRunningContainer(projectId);
    if (!container) return false;

    const install = await installStepFor(projectId);
    if (!install) return false;

    if (!(await needsPrebuild(projectId, container))) return false;

    // Read AFTER the decision and before the run, so what gets stamped is what
    // was actually installed against -- a dependency file edited while this was
    // deciding must not be stamped as done.
    const fingerprint = await dependencyFingerprint(projectId);
    if (fingerprint === null) return false;

    logger.info("prebuilding", { projectId });
    const result = await withTimeout(
      execCapture(container, ["sh", "-lc", install]),
      null,
    );

    if (!result) {
      // Abandoned. The stamp is untouched, so the next start installs exactly
      // as it would have.
      increment("prebuilds_abandoned");
      logger.info("a prebuild ran out of time", { projectId });
      return false;
    }

    if (result.exitCode !== 0) {
      increment("prebuilds_failed");
      // Logged and not announced: nobody asked for this, and telling somebody
      // their unasked-for background install failed is an interruption bought
      // with a saved minute.
      logger.info("a prebuild did not succeed", {
        projectId,
        exitCode: result.exitCode,
      });
      return false;
    }

    // Re-read rather than trusting the earlier value: an install takes minutes
    // and a lockfile can move underneath it. Stamping the old fingerprint
    // would claim an install that never happened for the files as they now
    // stand -- and the failure direction has to stay "install again
    // unnecessarily", never "serve against dependencies that are not there".
    const after = await dependencyFingerprint(projectId);
    if (after !== fingerprint) {
      logger.info("dependencies moved while prebuilding; not stamping", {
        projectId,
      });
      return false;
    }

    await writeStamp(container, fingerprint);
    increment("prebuilds_completed");
    return true;
  } catch (error) {
    increment("prebuilds_failed");
    logger.info("a prebuild failed", { projectId, error });
    return false;
  }
}

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Prebuilds every running workspace whose dependencies have moved.
 *
 *  Running only, per the note at the top. Sequential by construction —
 *  `prebuild` serialises — so this returns once they have all been considered
 *  rather than starting a stampede.
 */
export async function sweepPrebuilds(): Promise<number> {
  const projectIds = await runningProjectContainers();

  let built = 0;
  for (const projectId of projectIds) {
    if (await prebuild(projectId)) built += 1;
  }

  if (built > 0) logger.info("prebuilt workspaces", { built });
  return built;
}
