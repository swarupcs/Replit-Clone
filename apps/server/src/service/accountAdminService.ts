import {
  ACCOUNT_SEARCH_LIMIT,
  MAX_ACCOUNT_REASON,
  type AccountAction,
  type AccountActionType,
  type AccountDetail,
  type AccountRow,
  type EntitlementLimits,
  type MachineStatus,
} from "@replit-clone/shared";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment, snapshot } from "../lib/metrics.js";
import { runningContainerCount } from "../containers/containerManager.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import {
  forgetEntitlements,
  listPlans,
  parseOverride,
  resolveEntitlements,
} from "./entitlementService.js";
import { getUserUsage } from "./userQuotaService.js";
import { notify } from "./notificationService.js";

/** Looking up an account, and changing what it is allowed.
 *
 *  This is the first authority in the product that acts on a **person** rather
 *  than on a project, and §6 decision 11 is explicit that the moderation power
 *  is small precisely because nothing reviews it. So three things are true of
 *  every write here, and none of them is a later commit:
 *
 *  - it is recorded in `account_actions`, in the same transaction as the
 *    change, so the log cannot be missing the entry for the thing it exists to
 *    describe;
 *  - the reason is required, because an operator who can silently change what
 *    somebody pays for is a worse position than this product was in before;
 *  - and the account holder is **told**, which is the same argument the
 *    takedown notification makes. A decision taken about somebody by somebody
 *    else is one they hear from us, not one they discover from a refusal.
 *
 *  Suspension is deliberately absent — see the note in the shared types.
 */

function assertReason(raw: string): string {
  const reason = raw.trim();

  if (reason.length === 0) {
    throw new BadRequestError(
      "Say why this account is being changed.",
      "REASON_REQUIRED",
    );
  }

  if (reason.length > MAX_ACCOUNT_REASON) {
    throw new BadRequestError(
      `Keep the reason under ${String(MAX_ACCOUNT_REASON)} characters.`,
      "REASON_TOO_LONG",
    );
  }

  return reason;
}

function toAction(row: {
  id: string;
  subjectUserId: string | null;
  subjectEmail: string;
  action: string;
  actor: string;
  reason: string;
  detail: string | null;
  createdAt: Date;
}): AccountAction {
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    subjectEmail: row.subjectEmail,
    action: row.action as AccountActionType,
    actor: row.actor,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Finding somebody. A substring of their address, case-insensitively, which
 *  is what an operator has when a person writes in.
 *
 *  Disk is deliberately not here: it costs a walk of every tree the account
 *  owns, and multiplying that by twenty-five rows would make the search the
 *  most expensive request in the product. Open one account to see it.
 */
export async function searchAccounts(query: string): Promise<AccountRow[]> {
  const term = query.trim();

  const rows = await prisma.user.findMany({
    where: term.length > 0
      ? { email: { contains: term, mode: "insensitive" } }
      : {},
    orderBy: { createdAt: "desc" },
    take: ACCOUNT_SEARCH_LIMIT,
    select: {
      id: true,
      email: true,
      createdAt: true,
      entitlementOverride: true,
      overrideUntil: true,
      plan: { select: { id: true, label: true } },
      _count: { select: { projects: true } },
    },
  });

  return rows.map((row) => ({
    userId: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    planId: row.plan.id,
    planLabel: row.plan.label,
    projects: row._count.projects,
    overridden:
      parseOverride(row.entitlementOverride) !== undefined &&
      (row.overrideUntil === null || row.overrideUntil.getTime() > Date.now()),
  }));
}

/** One account, opened: what it is allowed, what it is using, and what has
 *  been done to it. The third is the part the account holder cannot see and
 *  the operator must. */
export async function getAccountDetail(userId: string): Promise<AccountDetail> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, createdAt: true },
  });

  if (!user) throw new NotFoundError("No such account.", "ACCOUNT_NOT_FOUND");

  const [entitlements, usage, actions, plans] = await Promise.all([
    resolveEntitlements(userId),
    getUserUsage(userId),
    prisma.accountAction.findMany({
      where: { subjectUserId: userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    listPlans(),
  ]);

  return {
    userId: user.id,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
    entitlements,
    projects: usage.projects,
    diskBytes: usage.diskBytes,
    actions: actions.map(toAction),
    plans,
  };
}

/** Everything recent, for an operator with no particular account in mind. */
export async function listRecentAccountActions(
  limit = 100,
): Promise<AccountAction[]> {
  const rows = await prisma.accountAction.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map(toAction);
}

/** Tells the subject, without letting a failed announcement undo the change. */
async function announce(
  userId: string,
  title: string,
  body: string,
): Promise<void> {
  await notify({
    userId,
    kind: "PLAN_CHANGED",
    title,
    body,
    link: "/?view=account",
  });
}

/** Moves an account to a different plan. */
export async function setAccountPlan(input: {
  userId: string;
  planId: string;
  actor: string;
  reason: string;
}): Promise<AccountAction> {
  const reason = assertReason(input.reason);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true, plan: { select: { id: true, label: true } } },
  });
  if (!user) throw new NotFoundError("No such account.", "ACCOUNT_NOT_FOUND");

  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new NotFoundError("No such plan.", "PLAN_NOT_FOUND");

  // Archived plans can be moved AWAY from and not onto: the archive is what
  // stops a withdrawn tier being handed to somebody new, and an operator doing
  // it by hand is exactly the case it has to stop.
  if (plan.archivedAt !== null) {
    throw new BadRequestError(
      `The ${plan.label} plan is no longer offered.`,
      "PLAN_ARCHIVED",
    );
  }

  if (plan.id === user.plan.id) {
    throw new BadRequestError(
      `This account is already on ${plan.label}.`,
      "PLAN_UNCHANGED",
    );
  }

  const row = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      data: { planId: plan.id },
    });

    return tx.accountAction.create({
      data: {
        subjectUserId: input.userId,
        subjectEmail: user.email,
        action: "PLAN_CHANGED",
        actor: input.actor,
        reason,
        detail: `${user.plan.label} to ${plan.label}`,
      },
    });
  });

  // After the commit: the cache would otherwise serve the old plan for up to
  // its TTL, which is how somebody upgrades and is refused anyway.
  forgetEntitlements(input.userId);
  increment("account_plan_changed");
  logger.info("account plan changed", {
    userId: input.userId,
    actor: input.actor,
  });

  await announce(
    input.userId,
    `Your plan is now ${plan.label}`,
    `An operator moved this account from ${user.plan.label} to ${plan.label}. ` +
      `Reason given: ${reason}`,
  );

  return toAction(row);
}

/** Sets or clears the limits an account gets over its plan's.
 *
 *  `override: null` clears. Both are one function because they are one
 *  decision — "this account's limits are not its plan's, or they are again" —
 *  and splitting them would give the trail two shapes for one story.
 */
export async function setAccountOverride(input: {
  userId: string;
  override: Partial<EntitlementLimits> | null;
  expiresInDays?: number;
  actor: string;
  reason: string;
}): Promise<AccountAction> {
  const reason = assertReason(input.reason);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true, entitlementOverride: true },
  });
  if (!user) throw new NotFoundError("No such account.", "ACCOUNT_NOT_FOUND");

  // Validated by the same schema that reads it back, so an override that
  // cannot be parsed can never be stored — otherwise it would be silently
  // ignored at resolution time and an operator would believe it applied.
  if (input.override !== null && parseOverride(input.override) === undefined) {
    throw new BadRequestError(
      "Those are not limits this product has.",
      "BAD_OVERRIDE",
    );
  }

  const clearing = input.override === null;

  if (clearing && user.entitlementOverride === null) {
    throw new BadRequestError(
      "This account has no override to clear.",
      "NO_OVERRIDE",
    );
  }

  const expiresAt =
    clearing || input.expiresInDays === undefined
      ? null
      : new Date(Date.now() + input.expiresInDays * 86_400_000);

  const detail = clearing
    ? "back to the plan's limits"
    : Object.entries(input.override ?? {})
        .map(([key, value]) => `${key} ${String(value)}`)
        .join(", ");

  const row = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: input.userId },
      data: {
        // `Prisma.DbNull` would be the typed way to write SQL NULL here, but
        // importing the generated namespace to say "null" ties this file to
        // the generated path for one token. A cast at the one place a Json
        // column is written is the smaller cost.
        entitlementOverride: (clearing
          ? null
          : input.override) as unknown as object,
        overrideReason: clearing ? null : reason,
        overrideUntil: expiresAt,
      },
    });

    return tx.accountAction.create({
      data: {
        subjectUserId: input.userId,
        subjectEmail: user.email,
        action: clearing ? "OVERRIDE_CLEARED" : "OVERRIDE_SET",
        actor: input.actor,
        reason,
        detail,
      },
    });
  });

  forgetEntitlements(input.userId);
  increment("account_override_changed");

  await announce(
    input.userId,
    clearing ? "Your limits are back to your plan's" : "Your limits were changed",
    clearing
      ? `An operator removed the limits that had been set for this account by ` +
          `hand. It is back to what its plan allows. Reason given: ${reason}`
      : `An operator set limits for this account over its plan's: ${detail}. ` +
          `Reason given: ${reason}`,
  );

  return toAction(row);
}

/** Is this machine full?
 *
 *  The question the three-container cap makes an operator ask most often, and
 *  the one no screen could answer. `runningJobRuns` is here rather than in the
 *  counters because it is the one number whose *shape over time* is a defect
 *  report: it should return to zero, and §3.1 records why it may not.
 */
export async function getMachineStatus(): Promise<MachineStatus> {
  const [containersRunning, runningJobRuns] = await Promise.all([
    runningContainerCount().catch(() => 0),
    prisma.scheduledRun.count({ where: { status: "RUNNING" } }).catch(() => 0),
  ]);

  return {
    containersRunning,
    containerLimit: env.MAX_CONCURRENT_CONTAINERS,
    runningJobRuns,
    uptimeSeconds: Math.round(process.uptime()),
    memoryBytes: process.memoryUsage().rss,
    counters: snapshot(),
  };
}
