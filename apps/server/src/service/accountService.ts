import type { AccountSummary, ProjectUsage } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";
import { usedBytes } from "./diskUsageService.js";
import { listPlans, resolveEntitlements } from "./entitlementService.js";

/** What an account is using, against what it is allowed.
 *
 *  Both halves of that sentence existed already and neither was reachable:
 *  `getUserUsage` computes the numbers and `assertCanCreateProject` refuses on
 *  them, but nothing returned either to the person they are about. The only
 *  way to learn where you stood was to be refused — which is the worst
 *  possible moment to find out, and the refusal named a limit without saying
 *  how close you had been to it or which project was responsible.
 *
 *  Hence the breakdown. "You are out of space" is not something anybody can
 *  act on; "this project is 4 GB of the 5 you have" is.
 */

/** How many projects are named individually.
 *
 *  A cap rather than everything, because this walks each project's tree, and
 *  the tail of the list is not what anybody is looking for. The total above it
 *  covers every project, capped or not — a breakdown that quietly stopped
 *  summing to the total would be worse than no breakdown at all.
 */
const BREAKDOWN_LIMIT = 50;

export async function getAccountSummary(
  userId: string,
): Promise<AccountSummary> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user) throw new NotFoundError("No such account.", "ACCOUNT_NOT_FOUND");

  // Owned projects only. A project shared with somebody counts against
  // whoever owns it, not against everybody who can see it — the same rule the
  // quota itself applies.
  const projects = await prisma.project.findMany({
    // Trashed projects are excluded here for the same reason the quota
    // excludes them: this screen exists to explain the number the quota
    // enforces, and a breakdown that does not add up to it is worse than none.
    where: { ownerId: userId, deletedAt: null },
    select: { id: true, name: true },
  });

  const measured: ProjectUsage[] = [];
  let diskBytes = 0;

  for (const project of projects) {
    const bytes = await usedBytes(project.id);
    diskBytes += bytes;
    measured.push({ projectId: project.id, name: project.name, diskBytes: bytes });
  }

  measured.sort((a, b) => b.diskBytes - a.diskBytes);

  const [entitlements, plans] = await Promise.all([
    resolveEntitlements(userId),
    listPlans(),
  ]);

  return {
    email: user.email,
    entitlements,
    projects: projects.length,
    diskBytes,
    breakdown: measured.slice(0, BREAKDOWN_LIMIT),
    plans,
  };
}
