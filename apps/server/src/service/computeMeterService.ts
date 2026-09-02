import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { runningProjectContainers } from "../containers/containerManager.js";
import { runningServices } from "../containers/deployContainer.js";

/** A meter for the thing this platform actually spends.
 *
 *  What is limited here is disk and project count. What is *expensive* is
 *  container-hours, and until now nothing counted them — so plan.md §8.8's
 *  question, whether this product sells capability or sells minutes, had no
 *  data behind it at all. This is the data. It is recorded and never enforced:
 *  nothing in the codebase refuses anything on this number.
 *
 *  **Sampled, not sessioned**, and that is the one decision that carries the
 *  file. A `startedAt`/`endedAt` row per container is the obvious shape and it
 *  is §2.26's restart wedge wearing a different hat: a row with an open end, a
 *  process that stops existing, and a total that is wrong forever afterwards.
 *  A sweep that adds elapsed seconds to a day loses at most one tick to a
 *  restart, leaves nothing open, and fails by undercounting — which is the
 *  right direction for a number that may one day be a bill.
 */

/** How often the sweep runs. Matches the idle reaper, deliberately: the reaper
 *  is what bounds how long an abandoned container keeps costing, so measuring
 *  on a finer grain would be measuring below the resolution of the thing that
 *  decides. */
export const SAMPLE_INTERVAL_MS = 60_000;

/** The most one tick may attribute, however long the gap was.
 *
 *  A laptop that slept for six hours, a debugger paused on a breakpoint, or a
 *  host that was simply busy all produce one enormous delta. Charging it would
 *  be inventing usage: the container may well have been running, but this
 *  process was not watching, and a meter that guesses upward is the one nobody
 *  can defend. Capped at two ticks, so an ordinary late sweep is still counted.
 */
const MAX_TICK_MS = SAMPLE_INTERVAL_MS * 2;

let lastSampleAt: number | undefined;

/** Reset between tests, and after a deliberate pause. */
export function resetComputeMeter(): void {
  lastSampleAt = undefined;
}

function startOfDayUtc(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Every project that is costing this host something right now.
 *
 *  Both kinds of container, because both are real money and one of them is the
 *  expensive one: a sandbox stops when the reaper says so, and a published
 *  service is always-on by definition. A meter that counted only the first
 *  would be quietest about exactly the case §8.8 is asking about.
 */
async function runningProjectIds(): Promise<string[]> {
  const ids = await runningProjectContainers();

  const subdomains = [...(await runningServices())];
  if (subdomains.length > 0) {
    const rows = await prisma.deployment.findMany({
      where: { subdomain: { in: subdomains } },
      select: { projectId: true },
    });
    for (const row of rows) ids.push(row.projectId);
  }

  return ids;
}

/** One tick. Adds the elapsed seconds to each running project's owner.
 *
 *  Never throws: a meter that can stop the sweep it lives in is worse than no
 *  meter, because the first thing it would take down is the idle reaper's
 *  neighbour.
 */
export async function sampleCompute(now = new Date()): Promise<number> {
  const previous = lastSampleAt;
  lastSampleAt = now.getTime();

  // The first tick after boot has nothing to measure from. Counting it as a
  // full interval would attribute a minute nobody was here for.
  if (previous === undefined) return 0;

  const elapsedMs = Math.min(now.getTime() - previous, MAX_TICK_MS);
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds <= 0) return 0;

  const projectIds = await runningProjectIds();
  if (projectIds.length === 0) return 0;

  // A trashed project's containers are stopped, so it should not appear here
  // — but the owner lookup filters anyway, because a stopped container that
  // Docker has not finished reporting is a metering error nobody would notice.
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, deletedAt: null },
    select: { id: true, ownerId: true },
  });

  const byOwner = new Map<string, number>();
  for (const project of projects) {
    // Counted per container and not per project: a project with a managed
    // database runs two, and two is what it costs the host.
    const times = projectIds.filter((id) => id === project.id).length;
    byOwner.set(project.ownerId, (byOwner.get(project.ownerId) ?? 0) + times * seconds);
  }

  const day = startOfDayUtc(now);
  let counted = 0;

  for (const [userId, amount] of byOwner) {
    try {
      await prisma.computeUsage.upsert({
        where: { userId_day: { userId, day } },
        create: { userId, day, seconds: amount },
        update: { seconds: { increment: amount } },
      });
      counted += amount;
    } catch (error) {
      // One account whose row will not write must not cost every other account
      // its measurement for the minute.
      logger.error("could not record compute usage", error, { userId });
    }
  }

  if (counted > 0) increment("compute_seconds", counted);
  return counted;
}

let timer: NodeJS.Timeout | undefined;

export function startComputeMeter(): void {
  // No sample at boot, unlike the other sweeps here: the first tick has no
  // previous reading, so calling it immediately only sets the clock.
  timer = setInterval(() => {
    void sampleCompute().catch((error: unknown) => {
      logger.error("compute meter failed", error);
    });
  }, SAMPLE_INTERVAL_MS);

  timer.unref();
}

export function stopComputeMeter(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Container-seconds for this account since a moment — the calendar month, for
 *  the account screen. */
export async function computeSecondsSince(
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await prisma.computeUsage.findMany({
    where: { userId, day: { gte: startOfDayUtc(since) } },
    select: { seconds: true },
  });

  return rows.reduce((total, row) => total + row.seconds, 0);
}

/** The first instant of the current UTC month. */
export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
