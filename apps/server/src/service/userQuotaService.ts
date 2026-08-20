import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../utils/errors.js";
import { increment } from "../lib/metrics.js";
import { usedBytes } from "./diskUsageService.js";

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

  return {
    projects: projects.length,
    projectLimit: env.MAX_PROJECTS_PER_USER,
    diskBytes,
    diskLimitBytes: env.USER_DISK_QUOTA_MB * 1024 * 1024,
  };
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
      `Your projects are using all ${String(env.USER_DISK_QUOTA_MB)} MB of ` +
        `available space. Delete or download something first.`,
      "USER_DISK_LIMIT",
    );
  }
}
