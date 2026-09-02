import {
  BILLING_GRACE_DAYS,
  FREE_PLAN_ID,
  type SubscriptionState,
  type SubscriptionStatus,
} from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { forgetEntitlements } from "./entitlementService.js";
import { notify } from "./notificationService.js";

/** Subscription state, with no processor attached to it.
 *
 *  §9.4 splits §8.4 the way §2.12 split custom domains: everything except the
 *  part that needs a credential somebody else owns. Creating a Checkout
 *  session and a Portal session are two calls to a live API and are **not**
 *  here — see `routes/v1/billing.ts`, which reports the feature as
 *  unconfigured rather than pretending.
 *
 *  Three rules carry this file, and each one is the harder of two options:
 *
 *  1. **The webhook is the only writer.** The post-checkout redirect is a
 *     browser event: it can be dropped, replayed, or hit by somebody who never
 *     paid. Granting the plan on redirect is what most tutorials show and it
 *     is wrong. §6 decision 13 in another costume — the guarantee lives where
 *     it cannot be skipped.
 *  2. **Billing writes one column.** `User.planId`, which every limit in this
 *     product already resolves from (§2.22). A subscription that decided
 *     entitlements directly would be a second answer to a question that has
 *     one.
 *  3. **A downgrade never deletes and never seizes.** An account that stops
 *     paying is blocked at the boundary — no new projects, no growth past the
 *     free quota — and keeps everything it has, running and exportable.
 *     Deleting a customer's work the moment they stop paying is both the
 *     obvious implementation and the one that would end this product, and it
 *     is a `WHERE` clause somebody could add in an afternoon.
 */

/** Stripe's subscription statuses, collapsed to the four this product asks
 *  about.
 *
 *  In one place on purpose. Stripe distinguishes a dozen, most of them about
 *  the payment intent rather than the entitlement, and mapping them at each
 *  call site is how a status nobody has heard of reaches a screen.
 *
 *  `incomplete` maps to CANCELED rather than to ACTIVE: a subscription whose
 *  first payment has not gone through has bought nothing yet, and the failure
 *  direction that matters is not granting a paid plan to somebody who has not
 *  paid.
 */
export function toStatus(raw: string): SubscriptionStatus {
  switch (raw) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    default:
      return "CANCELED";
  }
}

/** Whether this subscription entitles the account to its plan right now.
 *
 *  The only question the rest of the product asks, and the only place the
 *  grace period is interpreted.
 */
export function isEntitled(
  subscription: { status: SubscriptionStatus; graceUntil: Date | null },
  now = new Date(),
): boolean {
  if (subscription.status === "ACTIVE" || subscription.status === "TRIALING") {
    return true;
  }

  // Past due is entitled until the grace runs out. A missing `graceUntil` on a
  // PAST_DUE row means nothing set one, and the safe reading of "we do not
  // know when this stops being tolerated" is that it already has -- otherwise
  // a null is an unlimited free plan.
  if (subscription.status === "PAST_DUE") {
    return subscription.graceUntil !== null && subscription.graceUntil > now;
  }

  return false;
}

/** The plan an account should be on, given its subscription. */
export function effectivePlanId(
  subscription: {
    status: SubscriptionStatus;
    planId: string;
    graceUntil: Date | null;
  } | null,
  now = new Date(),
): string {
  if (!subscription) return FREE_PLAN_ID;
  return isEntitled(subscription, now) ? subscription.planId : FREE_PLAN_ID;
}

function graceFor(status: SubscriptionStatus, existing: Date | null, now: Date): Date | null {
  if (status !== "PAST_DUE") return null;
  // Not restarted on every redelivery: a webhook that arrives twice, or a
  // second failed attempt on the same card, must not buy another week.
  return existing ?? new Date(now.getTime() + BILLING_GRACE_DAYS * 86_400_000);
}

/** What a processor event says, once it has been verified and parsed.
 *
 *  Deliberately a plain shape and not Stripe's: this file is testable against
 *  it without a key, an SDK or a network, which is the whole point of §9.4.
 */
export interface SubscriptionUpdate {
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  customerId?: string | null;
  subscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
}

/** Applies one subscription update and puts the account on the right plan.
 *
 *  Both in one transaction: an account whose subscription says ACTIVE while
 *  its `planId` says free is a customer paying for nothing, and the gap would
 *  open exactly when a write failed halfway.
 */
export async function applySubscription(
  update: SubscriptionUpdate,
  now = new Date(),
): Promise<void> {
  const existing = await prisma.subscription.findUnique({
    where: { userId: update.userId },
    select: { graceUntil: true, status: true },
  });

  const graceUntil = graceFor(
    update.status,
    existing?.status === "PAST_DUE" ? existing.graceUntil : null,
    now,
  );

  const planId = effectivePlanId(
    { status: update.status, planId: update.planId, graceUntil },
    now,
  );

  await prisma.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: { userId: update.userId },
      create: {
        userId: update.userId,
        planId: update.planId,
        status: update.status,
        customerId: update.customerId ?? null,
        subscriptionId: update.subscriptionId ?? null,
        currentPeriodEnd: update.currentPeriodEnd ?? null,
        graceUntil,
      },
      update: {
        // The plan the subscription is FOR is kept even when the account is
        // not on it: that is what makes recovery a status change rather than a
        // guess about what somebody used to pay for.
        planId: update.planId,
        status: update.status,
        customerId: update.customerId ?? undefined,
        subscriptionId: update.subscriptionId ?? undefined,
        currentPeriodEnd: update.currentPeriodEnd ?? null,
        graceUntil,
      },
    });

    await tx.user.update({ where: { id: update.userId }, data: { planId } });
  });

  forgetEntitlements(update.userId);
  increment("billing_subscription_updated");

  await announce(update.userId, update.status, graceUntil, planId);
}

/** Tells the account holder when their subscription changes state.
 *
 *  On the CHANGE and never on the state (§6 decision 14), which here means the
 *  two moments a person can act on: a payment has failed and there is a date
 *  attached to it, and the plan has actually gone. A monthly renewal is not
 *  news and says nothing.
 */
async function announce(
  userId: string,
  status: SubscriptionStatus,
  graceUntil: Date | null,
  planId: string,
): Promise<void> {
  try {
    if (status === "PAST_DUE" && graceUntil) {
      await notify({
        userId,
        kind: "BILLING_PROBLEM",
        title: "A payment did not go through",
        body:
          `Your card was declined. Nothing has changed yet — your projects ` +
          `keep running and your plan is unchanged until ` +
          `${graceUntil.toDateString()}. After that the account moves to the ` +
          `free plan: nothing is deleted, but it stops being able to grow.`,
        link: "/?view=account",
      });
      return;
    }

    if (status === "CANCELED" && planId === FREE_PLAN_ID) {
      await notify({
        userId,
        kind: "BILLING_PROBLEM",
        title: "Your subscription has ended",
        body:
          `This account is on the free plan from now on. Everything you have ` +
          `is still here, still running and still exportable — what changes ` +
          `is the limits on making more.`,
        link: "/?view=account",
      });
    }
  } catch (error) {
    // A notification that fails must not roll back a payment state that is
    // already true.
    logger.error("could not announce a billing change", error, { userId });
  }
}

/** Drops accounts whose grace has run out to the free plan.
 *
 *  Necessary because nothing else would. The processor sends an event when a
 *  payment fails and another when the subscription is finally cancelled, and
 *  between them there is a week in which no event arrives at all — so a
 *  deployment relying on webhooks alone would leave a lapsed account on its
 *  paid plan for as long as Stripe kept retrying.
 *
 *  Never throws, one account at a time: one row that will not update must not
 *  cost every other account its sweep.
 */
export async function expireGracePeriods(now = new Date()): Promise<number> {
  const lapsed = await prisma.subscription.findMany({
    where: { status: "PAST_DUE", graceUntil: { not: null, lt: now } },
    select: { userId: true, user: { select: { planId: true } } },
  });

  let dropped = 0;
  for (const row of lapsed) {
    // Already on free: the sweep is idempotent, and re-notifying somebody
    // every hour about a state they are already in is exactly what decision 14
    // exists to stop.
    if (row.user.planId === FREE_PLAN_ID) continue;

    try {
      await prisma.user.update({
        where: { id: row.userId },
        data: { planId: FREE_PLAN_ID },
      });
      forgetEntitlements(row.userId);
      increment("billing_grace_expired");
      dropped += 1;

      await announce(row.userId, "CANCELED", null, FREE_PLAN_ID);
    } catch (error) {
      logger.error("could not expire a grace period", error, { userId: row.userId });
    }
  }

  if (dropped > 0) logger.info("grace periods expired", { dropped });
  return dropped;
}

/** Records that an event has been applied, or reports that it already was.
 *
 *  Webhooks are at-least-once, so this is the dedupe, and it is a unique
 *  index rather than a read-then-write: the second delivery loses to the
 *  database instead of to a race between two workers.
 */
export async function claimEvent(id: string, type: string): Promise<boolean> {
  try {
    await prisma.billingEvent.create({ data: { id, type } });
    return true;
  } catch {
    // The only plausible failure here is the unique constraint, and the next
    // delivery of the same event will fail the same way. Anything else is a
    // database that is down, in which case refusing to apply the event is also
    // the right answer -- the processor will send it again.
    increment("billing_event_duplicate");
    return false;
  }
}

/** What the account screen shows. Null for an account that has never had a
 *  subscription, which is every account on a deployment with no processor. */
export async function getSubscriptionState(
  userId: string,
  now = new Date(),
): Promise<SubscriptionState | null> {
  const row = await prisma.subscription.findUnique({
    where: { userId },
    select: {
      status: true,
      planId: true,
      graceUntil: true,
      currentPeriodEnd: true,
      plan: { select: { label: true } },
    },
  });

  if (!row) return null;

  return {
    status: row.status,
    planId: row.planId,
    planLabel: row.plan.label,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    graceUntil: row.graceUntil?.toISOString() ?? null,
    entitled: isEntitled(row, now),
  };
}
