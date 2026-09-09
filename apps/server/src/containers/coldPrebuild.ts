import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { prisma } from "../lib/prisma.js";
import {
  ensureContainer,
  runningProjectContainers,
  stopContainer,
} from "./containerManager.js";
import { budgetMb, committedMb } from "../service/workspaceSizeService.js";
import { prebuild } from "./prebuild.js";
import { dependencyFingerprint } from "./warmStart.js";

/** Building a workspace that is STOPPED, before somebody opens it.
 *  plan.md §12.5.
 *
 *  §12.2 shipped the half where the container is already running, which covers
 *  a `git pull` that adds a dependency while you have the project open — and
 *  not the case its own title describes. The first open of a workspace that
 *  has been stopped all week still pays the full install with somebody
 *  watching.
 *
 *  **This row was not blocked on code. It was blocked on three numbers**, and
 *  §12.5 says twice that choosing them without having watched a real host is
 *  how a background task becomes the reason a machine is always busy. They are
 *  chosen here under the repository owner's instruction to decide rather than
 *  ask, they are `PREBUILD_MAX_COMMITTED`, `PREBUILD_RECENT_DAYS` and
 *  `PREBUILD_STOP_AFTER`, and every one of them is an env var so that the first
 *  operator to watch this misbehave retunes it without a deploy. The whole
 *  feature is off by default for the same reason.
 *
 *  **The three collisions §12.5 named, and what each gate does about them.**
 *
 *  1. *It spends memory the capacity gate is rationing, on work nobody asked
 *     for.* So it runs only while committed memory is below a fraction of the
 *     budget, measured the same way `assertFits` measures it — not against a
 *     count of containers, which says nothing about a host running one large
 *     workspace.
 *  2. *It fights the idle reaper, which exists to stop exactly this.* So it
 *     stops what it started, and only what it started.
 *  3. *On a plan whose workspaces never sleep, nothing would stop it again.*
 *     Same answer, and it is the reason the answer is not "leave it running
 *     because the plan allows it": a prebuilt container left up is
 *     indistinguishable, an hour later, from one the user opened.
 */

/** Whether the host has room to spend on work nobody asked for. */
export async function hasHeadroom(): Promise<boolean> {
  const [budget, committed] = await Promise.all([
    budgetMb(),
    runningProjectContainers().then(committedMb),
  ]);

  if (budget <= 0) return false;
  return committed / budget < env.PREBUILD_MAX_COMMITTED;
}

/** Workspaces worth building: stopped, and opened recently enough that the
 *  next open is plausibly soon.
 *
 *  A prebuild is only worth its memory if it is spent shortly before somebody
 *  arrives. A workspace nobody has touched in a month is one whose install
 *  will be stale again before it is wanted.
 */
export async function prebuildCandidates(
  runningIds: readonly string[],
): Promise<string[]> {
  const since =
    env.PREBUILD_RECENT_DAYS > 0
      ? new Date(Date.now() - env.PREBUILD_RECENT_DAYS * 24 * 60 * 60 * 1000)
      : undefined;

  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      ...(since ? { updatedAt: { gte: since } } : {}),
      // Not the ones already up: those are §12.2's, and it has already swept
      // them by the time this runs.
      id: { notIn: [...runningIds] },
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    // A cap as well as a filter. The gates below stop this mid-sweep anyway,
    // but a query that could return every project on a large deployment is a
    // query somebody will regret.
    take: 50,
  });

  return projects.map((project) => project.id);
}

/** Builds one stopped workspace and puts the machine back as it found it.
 *
 *  Returns whether anything was built. Never throws: nobody asked for this
 *  work, and §12.2's rule holds here too — a prebuild that fails says nothing
 *  to anybody, because a notification about work nobody requested converts a
 *  saved minute into an interruption.
 */
export async function coldPrebuild(projectId: string): Promise<boolean> {
  // Asked BEFORE starting anything, against the host-side copy of the stamp.
  // The container's own stamp is unreachable here by definition -- there is no
  // container -- so this compares the dependency files, which ARE readable
  // from the host because the tree is bind-mounted, against what a prebuild
  // last recorded. A workspace whose install is already current costs nothing
  // to skip, and skipping is the common case.
  const fingerprint = await dependencyFingerprint(projectId);
  // No dependency files at all: a static template. Nothing to install.
  if (fingerprint === null) return false;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { prebuiltFingerprint: true },
  });
  if (project?.prebuiltFingerprint === fingerprint) return false;

  let started = false;

  try {
    // Was it already up? Only what this started gets stopped, so a workspace
    // somebody opened while the sweep was deciding is left running.
    const runningBefore = await runningProjectContainers();
    if (runningBefore.includes(projectId)) return false;

    await ensureContainer(projectId);
    started = true;
    increment("prebuilds_cold_started");

    return await prebuild(projectId);
  } catch (error) {
    logger.warn("cold prebuild failed", { projectId, error });
    return false;
  } finally {
    if (started && env.PREBUILD_STOP_AFTER) {
      // Even when the build failed or threw. A container this started and did
      // not stop is the exact failure §12.5 predicted: a stopped workspace
      // silently converted into a running one.
      await stopContainer(projectId).catch((error: unknown) => {
        logger.warn("could not stop a prebuilt workspace", { projectId, error });
      });
    }
  }
}

/** One pass. Re-checks headroom between workspaces, because the reason to stop
 *  is usually something else starting. */
export async function sweepColdPrebuilds(): Promise<number> {
  if (!env.PREBUILD_STOPPED) return 0;
  if (!(await hasHeadroom())) return 0;

  const running = await runningProjectContainers();
  const candidates = await prebuildCandidates(running);

  let built = 0;
  for (const projectId of candidates) {
    // Between each one, not only at the start. A sweep that decided the host
    // was quiet ten minutes ago is not evidence about the host now, and the
    // whole premise is that this yields to real work.
    if (!(await hasHeadroom())) break;

    if (await coldPrebuild(projectId)) built += 1;
  }

  if (built > 0) logger.info("prebuilt stopped workspaces", { built });
  return built;
}
