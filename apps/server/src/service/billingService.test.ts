import { beforeEach, describe, expect, it, vi } from "vitest";

/** What a subscription does to an account.
 *
 *  §9.4 builds all of this without a Stripe account in existence, which is
 *  possible because the interesting part was never the API call. It is the
 *  three rules §8.4 wrote down before anybody could implement them:
 *
 *  1. the webhook is the only writer of subscription state,
 *  2. billing writes one column — `User.planId` — because §2.22 already made
 *     every limit resolve from it,
 *  3. **a downgrade never deletes and never seizes.**
 *
 *  The third is the one with a plausible wrong answer that is also easier to
 *  write, and §8.4 is explicit that it is a `WHERE` clause somebody could add
 *  in an afternoon. So it is tested by name.
 */

const subscriptionFindUnique = vi.hoisted(() => vi.fn());
const subscriptionFindMany = vi.hoisted(() => vi.fn());
const subscriptionUpsert = vi.hoisted(() => vi.fn());
const userUpdate = vi.hoisted(() => vi.fn());
const eventCreate = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => {
  const client = {
    subscription: {
      findUnique: subscriptionFindUnique,
      findMany: subscriptionFindMany,
      upsert: subscriptionUpsert,
    },
    user: { update: userUpdate },
    billingEvent: { create: eventCreate },
  };

  return {
    prisma: {
      ...client,
      // The upsert and the plan change go together or not at all: an account
      // whose subscription says ACTIVE while its planId says free is a
      // customer paying for nothing.
      $transaction: (run: (tx: unknown) => Promise<unknown>) => run(client),
    },
  };
});

const notify = vi.hoisted(() => vi.fn(() => Promise.resolve("n1")));
vi.mock("./notificationService.js", () => ({ notify, notifyAdmins: vi.fn() }));

const forgetEntitlements = vi.hoisted(() => vi.fn());
vi.mock("./entitlementService.js", () => ({ forgetEntitlements }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applySubscription,
  claimEvent,
  effectivePlanId,
  expireGracePeriods,
  isEntitled,
  toStatus,
} from "./billingService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const DAY = 86_400_000;

function planWritten(): string {
  return (userUpdate.mock.calls[0]?.[0] as { data: { planId: string } }).data.planId;
}

function subscriptionWritten(): Record<string, unknown> {
  return (subscriptionUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> })
    .create;
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionFindUnique.mockResolvedValue(null);
  subscriptionFindMany.mockResolvedValue([]);
  subscriptionUpsert.mockResolvedValue({});
  userUpdate.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  notify.mockResolvedValue("n1");
});

describe("reading the processor's status", () => {
  it("keeps the four this product asks about", () => {
    expect(toStatus("active")).toBe("ACTIVE");
    expect(toStatus("trialing")).toBe("TRIALING");
    expect(toStatus("past_due")).toBe("PAST_DUE");
    expect(toStatus("canceled")).toBe("CANCELED");
  });

  /** A subscription whose first payment has not gone through has bought
   *  nothing yet, and the failure direction that matters is not granting a
   *  paid plan to somebody who has not paid. */
  it("reads anything it does not know as not paid", () => {
    for (const raw of ["incomplete", "unpaid", "paused", "", "something_new"]) {
      expect(toStatus(raw)).toBe("CANCELED");
    }
  });
});

describe("who is entitled", () => {
  it("is anybody paying or trialing", () => {
    expect(isEntitled({ status: "ACTIVE", graceUntil: null }, NOW)).toBe(true);
    expect(isEntitled({ status: "TRIALING", graceUntil: null }, NOW)).toBe(true);
  });

  /** A card that expired on a Friday must not take somebody's work away on
   *  the Saturday. */
  it("includes a failed payment inside its grace", () => {
    const graceUntil = new Date(NOW.getTime() + 3 * DAY);

    expect(isEntitled({ status: "PAST_DUE", graceUntil }, NOW)).toBe(true);
  });

  it("stops when the grace runs out", () => {
    const graceUntil = new Date(NOW.getTime() - 1);

    expect(isEntitled({ status: "PAST_DUE", graceUntil }, NOW)).toBe(false);
  });

  /** A null on a PAST_DUE row means nothing set one, and the safe reading of
   *  "we do not know when this stops being tolerated" is that it already has
   *  — otherwise a missing date is an unlimited free plan. */
  it("does not read a missing grace date as forever", () => {
    expect(isEntitled({ status: "PAST_DUE", graceUntil: null }, NOW)).toBe(false);
  });

  it("excludes a cancelled subscription", () => {
    expect(isEntitled({ status: "CANCELED", graceUntil: null }, NOW)).toBe(false);
  });

  it("puts an account with no subscription at all on the free plan", () => {
    expect(effectivePlanId(null, NOW)).toBe("free");
  });
});

describe("applying an update", () => {
  it("writes the plan the account is entitled to, not the one it bought", async () => {
    await applySubscription(
      { userId: USER, planId: "pro", status: "CANCELED" },
      NOW,
    );

    expect(planWritten()).toBe("free");
    // ...and the subscription still records what it was FOR, which is what
    // makes recovery a status change rather than a guess.
    expect(subscriptionWritten()["planId"]).toBe("pro");
  });

  it("puts an active subscription on its plan", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "ACTIVE" }, NOW);

    expect(planWritten()).toBe("pro");
  });

  /** The cache is 30 seconds long, so without this an account that just paid
   *  is refused for half a minute — on the one screen where that reads as the
   *  payment not having worked. */
  it("forgets the cached entitlements", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "ACTIVE" }, NOW);

    expect(forgetEntitlements).toHaveBeenCalledWith(USER);
  });

  it("starts a grace period when a payment first fails", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "PAST_DUE" }, NOW);

    const grace = subscriptionWritten()["graceUntil"] as Date;
    expect(Math.round((grace.getTime() - NOW.getTime()) / DAY)).toBe(7);
    // Still on the paid plan: this is the whole point of a grace period.
    expect(planWritten()).toBe("pro");
  });

  /** A webhook that arrives twice, or a second failed attempt on the same
   *  card, must not buy another week. */
  it("does not restart a grace period that is already running", async () => {
    const started = new Date(NOW.getTime() - 5 * DAY);
    const graceUntil = new Date(started.getTime() + 7 * DAY);
    subscriptionFindUnique.mockResolvedValue({ status: "PAST_DUE", graceUntil });

    await applySubscription({ userId: USER, planId: "pro", status: "PAST_DUE" }, NOW);

    expect((subscriptionWritten()["graceUntil"] as Date).toISOString()).toBe(
      graceUntil.toISOString(),
    );
  });

  it("clears the grace when the payment goes through", async () => {
    subscriptionFindUnique.mockResolvedValue({
      status: "PAST_DUE",
      graceUntil: new Date(NOW.getTime() + DAY),
    });

    await applySubscription({ userId: USER, planId: "pro", status: "ACTIVE" }, NOW);

    // A state that outlives its cause is the defect §2.26 is about.
    expect(subscriptionWritten()["graceUntil"]).toBeNull();
    expect(planWritten()).toBe("pro");
  });
});

describe("what the account holder is told", () => {
  /** §6 decision 14: on the change, never on the state. */
  it("hears about a failed payment, with the date attached", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "PAST_DUE" }, NOW);

    const message = notify.mock.calls[0]?.[0] as { kind: string; body: string };
    expect(message.kind).toBe("BILLING_PROBLEM");
    // The two things somebody can act on: nothing has happened yet, and when
    // it will.
    expect(message.body).toMatch(/keep running/i);
  });

  /** A renewal that works is not news, and a message every month is how a
   *  channel somebody needs becomes one they filter. */
  it("hears nothing when a payment simply works", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "ACTIVE" }, NOW);

    expect(notify).not.toHaveBeenCalled();
  });

  /** The message that would be easiest to get wrong, and the one that would
   *  cost the most: nothing is deleted, and it has to say so. */
  it("is told plainly that nothing has been taken away", async () => {
    await applySubscription({ userId: USER, planId: "pro", status: "CANCELED" }, NOW);

    const message = notify.mock.calls[0]?.[0] as { body: string };
    expect(message.body).toMatch(/still here/i);
    expect(message.body).toMatch(/still running/i);
  });
});

describe("the grace sweep", () => {
  /** Necessary because nothing else would: the processor sends an event when
   *  a payment fails and another when it gives up, and between them is a week
   *  in which no event arrives at all. */
  it("drops a lapsed account to the free plan", async () => {
    subscriptionFindMany.mockResolvedValue([
      { userId: USER, user: { planId: "pro" } },
    ]);

    expect(await expireGracePeriods(NOW)).toBe(1);
    expect(planWritten()).toBe("free");
    expect(forgetEntitlements).toHaveBeenCalledWith(USER);
  });

  /** Re-notifying somebody every hour about a state they are already in is
   *  exactly what decision 14 exists to stop. */
  it("leaves an account already on free alone", async () => {
    subscriptionFindMany.mockResolvedValue([
      { userId: USER, user: { planId: "free" } },
    ]);

    expect(await expireGracePeriods(NOW)).toBe(0);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("asks only for graces that have actually run out", async () => {
    await expireGracePeriods(NOW);

    expect(subscriptionFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: "PAST_DUE", graceUntil: { not: null, lt: NOW } },
    });
  });

  it("carries on past an account it cannot update", async () => {
    subscriptionFindMany.mockResolvedValue([
      { userId: USER, user: { planId: "pro" } },
      { userId: "other", user: { planId: "pro" } },
    ]);
    userUpdate.mockRejectedValueOnce(new Error("deadlock"));

    expect(await expireGracePeriods(NOW)).toBe(1);
  });
});

describe("an event delivered twice", () => {
  /** Webhooks are at-least-once. The second copy has to lose to a unique
   *  index rather than to a race between two workers. */
  it("is claimed once", async () => {
    expect(await claimEvent("evt_1", "customer.subscription.updated")).toBe(true);

    eventCreate.mockRejectedValue(new Error("unique constraint"));
    expect(await claimEvent("evt_1", "customer.subscription.updated")).toBe(false);
  });
});
