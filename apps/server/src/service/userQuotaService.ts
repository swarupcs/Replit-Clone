import { QUOTA_WARN_FRACTION } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { notify } from "./notificationService.js";
import { AppError } from "../utils/errors.js";
import { increment } from "../lib/metrics.js";
import { usedBytes } from "./diskUsageService.js";
import {
  forgetEntitlements,
  ownerOf,
  resolveEntitlements,
} from "./entitlementService.js";

/** Per-user limits.
 *
 *  Only a global container cap existed, so a single account could take every
 *  slot on the machine and fill the disk on its own — nothing bounded what any
 *  one user cost the deployment.
 */

export class QuotaError extends AppError {
  constructor(message: string, code: string) {
    // 402 would imply this is about payment, and 403 implies a permission
    // problem. 429 is the honest one: the request is fine, there is just too
    // much of it.
    super(429, code, message);
  }
}

export interface UserUsage {
  projects: number;
  projectLimit: number;
  diskBytes: number;
  diskLimitBytes: number;
}

/** A limit stated in MB, in the bytes everything here actually compares. */
function toBytes(megabytes: number): number {
  return megabytes * 1024 * 1024;
}

/** What this user is currently costing. Owned projects only: a project shared
 *  with someone counts against whoever owns it, not everyone who can see it. */
export async function getUserUsage(userId: string): Promise<UserUsage> {
  const projects = await prisma.project.findMany({
    where: { ownerId: userId },
    select: { id: true },
  });

  let diskBytes = 0;
  for (const project of projects) {
    diskBytes += await usedBytes(project.id);
  }

  // The limits are this account's, not the deployment's. Before plans existed
  // they were the same two constants for everybody; `env` is now the free
  // plan's defaults and the fallback when the plan cannot be read at all.
  const entitlements = await resolveEntitlements(userId);

  const usage: UserUsage = {
    projects: projects.length,
    projectLimit: entitlements.maxProjects,
    diskBytes,
    diskLimitBytes: toBytes(entitlements.userDiskQuotaMb),
  };

  // Deliberately not awaited. This is the only place a fresh measurement
  // exists, which makes it the right place to notice a crossing — and a save
  // must not wait on an announcement about it. `reviewQuotaWarning` throws at
  // nobody.
  void reviewQuotaWarning(userId, usage);

  return usage;
}

/** Whether an account is inside the last fifth of either quota.
 *
 *  Either, not both: they are two different rooms to run out of, and being
 *  nearly out of one is the whole news. */
export function isNearQuota(usage: UserUsage): boolean {
  const disk =
    usage.diskLimitBytes > 0 && usage.diskBytes / usage.diskLimitBytes >= QUOTA_WARN_FRACTION;
  const projects =
    usage.projectLimit > 0 && usage.projects / usage.projectLimit >= QUOTA_WARN_FRACTION;

  return disk || projects;
}

/** Tells somebody they are nearly out of room, once, on the way in.
 *
 *  §6 decision 14 governs this and it is the whole design: the news is the
 *  CROSSING, not the state. An account that sits at 90% for a month is one
 *  message, because a message a week about a number that has not changed is
 *  how a warning people needed becomes a filter rule.
 *
 *  Dropping back under the line is silent, which is where this differs from a
 *  job recovering. A job that starts working again reverses a failure somebody
 *  was told about and may have been acting on; nobody was ever harmed by a
 *  wall they did not hit, and somebody who has just deleted a project to make
 *  room does not need to be told it worked. The bit is cleared, and that is
 *  all — so the next crossing speaks again.
 *
 *  One bit for both quotas rather than one each. The state being announced is
 *  "this account is running out of room", the message links to the screen that
 *  shows both meters, and a second mail the same week adding "also, projects"
 *  is exactly the thing decision 14 exists to prevent.
 */
export async function reviewQuotaWarning(
  userId: string,
  usage: UserUsage,
): Promise<void> {
  try {
    const near = isNearQuota(usage);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { quotaWarnedAt: true },
    });
    if (!user) return;

    const warned = user.quotaWarnedAt !== null;
    if (near === warned) return;

    await prisma.user.update({
      where: { id: userId },
      data: { quotaWarnedAt: near ? new Date() : null },
    });

    if (!near) return;

    const percent = Math.min(
      99,
      Math.round(
        Math.max(
          usage.diskLimitBytes > 0 ? usage.diskBytes / usage.diskLimitBytes : 0,
          usage.projectLimit > 0 ? usage.projects / usage.projectLimit : 0,
        ) * 100,
      ),
    );

    await notify({
      userId,
      kind: "QUOTA_WARNING",
      title: "You are nearly out of room",
      body:
        `This account is using about ${String(percent)}% of what its plan ` +
        `allows. Nothing has been refused yet — this is so that the first ` +
        `you hear of it is not a save that fails. You will not be told again ` +
        `unless it clears and happens again.`,
      link: "/?view=account",
    });
  } catch (error) {
    // A warning that could not be sent must not become a write that failed.
    logger.error("could not review a quota warning", error, { userId });
  }
}

/** How long a user's measured usage is trusted before it is worked out again.
 *
 *  This check sits on the write path — every debounced save, every flush of a
 *  shared document — and working it out means a query plus a walk of every one
 *  of that user's project trees. Doing that per keystroke-batch would cost far
 *  more than the limit is worth.
 */
const USAGE_CACHE_TTL_MS = 30_000;

/** How long to wait for the database before giving up on the check.
 *
 *  Deliberately fails OPEN. Refusing to save somebody's work because a quota
 *  lookup was slow is a worse outcome than briefly allowing a write that puts
 *  them over — the per-project quota still applies either way, so nothing is
 *  unbounded.
 */
const LOOKUP_TIMEOUT_MS = 2000;

const usageCache = new Map<string, { usage: UserUsage; measuredAt: number }>();

function withTimeout<T>(work: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        resolve(undefined);
      }, LOOKUP_TIMEOUT_MS).unref(),
    ),
  ]).catch(() => undefined);
}

async function cachedUsage(userId: string): Promise<UserUsage | undefined> {
  const cached = usageCache.get(userId);
  if (cached && Date.now() - cached.measuredAt < USAGE_CACHE_TTL_MS) {
    return cached.usage;
  }

  const usage = await withTimeout(getUserUsage(userId));
  if (!usage) return undefined;

  usageCache.set(userId, { usage, measuredAt: Date.now() });
  return usage;
}

/** Throws unless this user's projects may grow by `incomingBytes` more.
 *
 *  The per-project quota was the only one writes ever consulted, so the user
 *  limit bound exactly one action — starting a project — and nothing that
 *  actually consumes disk. With the defaults that left twenty projects at
 *  512 MB each, ten gigabytes, against a stated user limit of two.
 *
 *  Resolved through the project's OWNER, because that is who the space is
 *  counted against: a collaborator writing into someone else's project spends
 *  the owner's allowance, not their own.
 */
export async function assertUserDiskQuota(
  projectId: string,
  incomingBytes: number,
  replacingBytes = 0,
): Promise<void> {
  const ownerId = await ownerOf(projectId);
  if (!ownerId) return;

  const usage = await cachedUsage(ownerId);
  // Unreachable or too slow. See LOOKUP_TIMEOUT_MS: a quota check must never
  // be the reason a save fails.
  if (!usage) return;

  const projected = usage.diskBytes - replacingBytes + incomingBytes;

  if (projected > usage.diskLimitBytes) {
    increment("quota_rejections");
    throw new QuotaError(
      `These projects are using all ` +
        `${String(Math.round(usage.diskLimitBytes / 1024 / 1024))} MB of ` +
        `available space. Delete or download something first.`,
      "USER_DISK_LIMIT",
    );
  }

  // Kept roughly current between measurements, so a burst of writes is bounded
  // rather than all being waved through on one stale reading.
  usage.diskBytes = Math.max(0, projected);
}

/** Drops what is remembered about a user and a project, e.g. on deletion. */
export function forgetUserQuota(projectId: string, userId?: string): void {
  if (userId) usageCache.delete(userId);
  // The owner and the plan are remembered next door now. A caller that has
  // just deleted a project should not have to know that.
  forgetEntitlements(userId, projectId);
}

/** Only for tests, which need a clean slate between cases. */
export function resetUserQuotaCaches(): void {
  usageCache.clear();
}

/** Throws unless this user may create another project. */
export async function assertCanCreateProject(userId: string): Promise<void> {
  const usage = await getUserUsage(userId);

  if (usage.projects >= usage.projectLimit) {
    increment("quota_rejections");
    throw new QuotaError(
      `You have reached the limit of ${String(usage.projectLimit)} projects. ` +
        `Delete one to make room.`,
      "PROJECT_LIMIT",
    );
  }

  if (usage.diskBytes >= usage.diskLimitBytes) {
    increment("quota_rejections");
    throw new QuotaError(
      `Your projects are using all ` +
        `${String(Math.round(usage.diskLimitBytes / 1024 / 1024))} MB of ` +
        `available space. Delete or download something first.`,
      "USER_DISK_LIMIT",
    );
  }
}
