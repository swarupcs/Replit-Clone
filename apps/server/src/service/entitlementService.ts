import { z } from "zod";
import {
  FREE_PLAN_ID,
  type EntitlementLimits,
  type Entitlements,
  type Plan,
} from "@replit-clone/shared";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ForbiddenError } from "../utils/errors.js";

/** What an account is allowed to do.
 *
 *  Every limit in this product was a constant in `env`. That is the right
 *  shape for a deployment and the wrong one for a product: a SaaS product is
 *  precisely one in which these numbers differ per customer. They now come
 *  from a plan row, with an optional per-account override on top, and `env`
 *  has become the free plan's defaults rather than the whole story.
 *
 *  Two things this deliberately does not do:
 *
 *  It does not touch the machine's limits. `MAX_CONCURRENT_CONTAINERS`,
 *  `CONTAINER_MEMORY_MB` and `DEPLOY_MEMORY_MB` stay in `env` and no plan can
 *  raise them, because a plan that promises more memory per container than the
 *  host has is a promise kept by an OOM kill in somebody's terminal rather
 *  than by an honest refusal (plan.md §6 decision 15).
 *
 *  And it does not decide anything about payment. Nothing here knows what a
 *  subscription is. Billing, when it arrives, writes `planId` and stops —
 *  which is the whole reason this file exists before that one does.
 */

/** How long an account's entitlements are trusted before being read again.
 *
 *  The same reasoning, and the same number, as `userQuotaService`'s usage
 *  cache: these are consulted on the write path, and a plan changes a few
 *  times in an account's life. Thirty seconds of staleness after an upgrade is
 *  invisible to everyone; a query per debounced save is not.
 */
const CACHE_TTL_MS = 30_000;

/** How long to wait on the database before giving up.
 *
 *  Fails **open to the free plan**, not open to no limit at all. That is a
 *  deliberate middle: refusing somebody's save because a plan lookup was slow
 *  is a worse outcome than briefly applying smaller limits than they paid for,
 *  and applying *no* limits would make an unreachable database a way to buy an
 *  unbounded quota.
 */
const LOOKUP_TIMEOUT_MS = 2000;

/** The free plan as the code understands it, from `env`.
 *
 *  This exists so that a deployment whose database has never been migrated,
 *  or whose `plans` table somebody emptied, behaves exactly as it did before
 *  plans existed. The migration seeds a `free` row holding these same numbers;
 *  if the two ever disagree, the row wins for everybody it can be read for,
 *  and this is what is left when it cannot.
 */
export function freePlanFallback(): Entitlements {
  return {
    planId: FREE_PLAN_ID,
    planLabel: "Free",
    maxProjects: env.MAX_PROJECTS_PER_USER,
    userDiskQuotaMb: env.USER_DISK_QUOTA_MB,
    projectDiskQuotaMb: env.PROJECT_DISK_QUOTA_MB,
    aiRequestsPerHour: env.AI_REQUESTS_PER_HOUR,
    maxContainersPerUser: env.MAX_CONTAINERS_PER_USER,
    idleMinutes: env.CONTAINER_IDLE_MINUTES,
    managedDatabases: true,
    customDomains: true,
    devcontainerMounts: false,
    scheduledJobs: true,
    overridden: false,
    overrideUntil: null,
  };
}

/** The override, as it is allowed to be shaped.
 *
 *  A `Json` column is unvalidated at rest, so it is parsed on the way out
 *  rather than trusted. Every field is optional — an override is a partial —
 *  and every number is bounded below, because a negative quota is not a
 *  smaller limit but a different bug entirely.
 *
 *  `.strict()` on purpose: a key that is not a limit is far more likely to be
 *  a typo for one that is (`maxProject`, `diskQuotaMb`) than a deliberate
 *  extension, and silently ignoring it would apply the plan's number while an
 *  operator believed they had changed it.
 */
const overrideSchema = z
  .object({
    maxProjects: z.number().int().nonnegative().optional(),
    userDiskQuotaMb: z.number().int().nonnegative().optional(),
    projectDiskQuotaMb: z.number().int().nonnegative().optional(),
    aiRequestsPerHour: z.number().int().nonnegative().optional(),
    maxContainersPerUser: z.number().int().nonnegative().optional(),
    idleMinutes: z.number().int().nonnegative().optional(),
    managedDatabases: z.boolean().optional(),
    devcontainerMounts: z.boolean().optional(),
    customDomains: z.boolean().optional(),
    scheduledJobs: z.boolean().optional(),
  })
  .strict();

export type EntitlementOverride = Partial<EntitlementLimits>;

/** Reads an override, or nothing at all.
 *
 *  A row that fails to parse falls back to the plan — never to something more
 *  generous. Garbage in this column must not be a way to buy a bigger quota,
 *  and of the two ways to be wrong, giving somebody their plan's limits is the
 *  one that can be noticed and fixed.
 */
export function parseOverride(value: unknown): EntitlementOverride | undefined {
  if (value === null || value === undefined) return undefined;

  const parsed = overrideSchema.safeParse(value);
  if (!parsed.success) return undefined;

  return Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

interface Cached {
  entitlements: Entitlements;
  readAt: number;
}

const cache = new Map<string, Cached>();

/** A project's owner never changes, so it is worth remembering outright.
 *
 *  Lives here rather than in `userQuotaService`, which used to keep its own
 *  copy: two caches of the same immutable fact is one more than is useful, and
 *  the per-project disk limit needs the same lookup now that it is per-plan. */
const ownerCache = new Map<string, string>();

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

/** Plan, then override on top, then a note that it happened. */
function apply(
  plan: {
    id: string;
    label: string;
    maxProjects: number;
    userDiskQuotaMb: number;
    projectDiskQuotaMb: number;
    aiRequestsPerHour: number;
    maxContainersPerUser: number;
    idleMinutes: number;
    managedDatabases: boolean;
    devcontainerMounts: boolean;
    customDomains: boolean;
    scheduledJobs: boolean;
  },
  override: EntitlementOverride | undefined,
  overrideUntil: Date | null,
): Entitlements {
  const base: EntitlementLimits = {
    maxProjects: plan.maxProjects,
    userDiskQuotaMb: plan.userDiskQuotaMb,
    projectDiskQuotaMb: plan.projectDiskQuotaMb,
    aiRequestsPerHour: plan.aiRequestsPerHour,
    maxContainersPerUser: plan.maxContainersPerUser,
    idleMinutes: plan.idleMinutes,
    managedDatabases: plan.managedDatabases,
    devcontainerMounts: plan.devcontainerMounts,
    customDomains: plan.customDomains,
    scheduledJobs: plan.scheduledJobs,
  };

  return {
    ...base,
    ...(override ?? {}),
    // The plan of record, even when every number has been overridden. An
    // account comped up to Pro limits is still on the plan it pays for, and
    // conflating those two is how a billing system starts lying about revenue.
    planId: plan.id,
    planLabel: plan.label,
    overridden: override !== undefined,
    overrideUntil: override ? (overrideUntil?.toISOString() ?? null) : null,
  };
}

/** What this account may do, from cache when it is fresh enough. */
export async function resolveEntitlements(
  userId: string,
): Promise<Entitlements> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
    return cached.entitlements;
  }

  const user = await withTimeout(
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        entitlementOverride: true,
        overrideUntil: true,
        plan: true,
      },
    }),
  );

  // Unreachable, too slow, or an account that no longer exists. See
  // LOOKUP_TIMEOUT_MS: this must never be the reason a save fails.
  if (!user) return freePlanFallback();

  // An expired override is not applied and is not cleaned up here. Deleting it
  // is a write on a read path, and the row is also the record of what an
  // operator granted and when — worth keeping after it lapses.
  const live =
    user.overrideUntil === null || user.overrideUntil.getTime() > Date.now();

  const entitlements = apply(
    user.plan,
    live ? parseOverride(user.entitlementOverride) : undefined,
    user.overrideUntil,
  );

  cache.set(userId, { entitlements, readAt: Date.now() });
  return entitlements;
}

/** The owner of a project, remembered. */
export async function ownerOf(projectId: string): Promise<string | undefined> {
  const known = ownerCache.get(projectId);
  if (known) return known;

  const project = await withTimeout(
    prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    }),
  );

  if (!project) return undefined;

  ownerCache.set(projectId, project.ownerId);
  return project.ownerId;
}

/** What applies to work done *in* a project, which is its owner's allowance.
 *
 *  A collaborator writing into someone else's project spends the owner's
 *  quota, not their own — the same rule `assertUserDiskQuota` already applied
 *  to disk, extended to the plan that decides how much disk there is. */
export async function resolveProjectEntitlements(
  projectId: string,
): Promise<Entitlements> {
  const ownerId = await ownerOf(projectId);
  if (!ownerId) return freePlanFallback();
  return resolveEntitlements(ownerId);
}

/** Which of a plan's features are gates rather than amounts. */
export type PlanFeature =
  | "managedDatabases"
  | "customDomains"
  | "scheduledJobs";

const FEATURE_LABEL: Record<PlanFeature, string> = {
  managedDatabases: "Managed databases are",
  customDomains: "Custom domains are",
  scheduledJobs: "Scheduled jobs are",
};

/** Refuses a feature this project's owner's plan does not include.
 *
 *  Checked where the thing is CREATED and nowhere else, deliberately. A plan
 *  that lapses does not delete the scheduled jobs somebody already has or stop
 *  them running — an account that drops a tier is blocked at the boundary, not
 *  seized (plan.md §8.4). Enforcing it on the run path as well would be the
 *  version of this that destroys work at the moment somebody stops paying.
 *
 *  A 403, not a 402: whether payment would fix it is a fact about the pricing
 *  page, and this is the same shape of refusal as any other thing an account
 *  is not permitted to do.
 */
export async function assertFeature(
  projectId: string,
  feature: PlanFeature,
): Promise<void> {
  const entitlements = await resolveProjectEntitlements(projectId);
  if (entitlements[feature]) return;

  throw new ForbiddenError(
    `${FEATURE_LABEL[feature]} not included in the ` +
      `${entitlements.planLabel} plan.`,
    "PLAN_FEATURE",
  );
}

/** The catalogue, for the account screen and for anything that has to name a
 *  plan. Archived plans are omitted: an account already on one keeps every
 *  number, and offering it to somebody new is what archiving stops. */
export async function listPlans(): Promise<Plan[]> {
  const rows = await prisma.plan.findMany({
    where: { archivedAt: null },
    orderBy: { rank: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    priceCents: row.priceCents,
    currency: row.currency,
    rank: row.rank,
    maxProjects: row.maxProjects,
    userDiskQuotaMb: row.userDiskQuotaMb,
    projectDiskQuotaMb: row.projectDiskQuotaMb,
    aiRequestsPerHour: row.aiRequestsPerHour,
    maxContainersPerUser: row.maxContainersPerUser,
    idleMinutes: row.idleMinutes,
    managedDatabases: row.managedDatabases,
    devcontainerMounts: row.devcontainerMounts,
    customDomains: row.customDomains,
    scheduledJobs: row.scheduledJobs,
  }));
}

/** Drops what is remembered, e.g. when a plan changes or a project is deleted.
 *
 *  Both arguments are optional and independent: a plan change forgets a user,
 *  a deletion forgets a project, and neither implies the other. */
export function forgetEntitlements(userId?: string, projectId?: string): void {
  if (userId) cache.delete(userId);
  if (projectId) ownerCache.delete(projectId);
}

/** Only for tests, which need a clean slate between cases. */
export function resetEntitlementCaches(): void {
  cache.clear();
  ownerCache.clear();
}
