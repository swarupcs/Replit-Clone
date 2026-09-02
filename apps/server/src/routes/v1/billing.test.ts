import { createHmac } from "node:crypto";
import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one public endpoint in this product that can grant a paid plan.
 *
 *  §9.4's whole argument is that the webhook is the only writer of
 *  subscription state, which makes this route the entire trust boundary
 *  around billing: everything behind it believes what it says. So what it is
 *  tested for is what it refuses, and the two ways a wrong answer costs
 *  something real —
 *
 *  - accepting an event nobody signed, which is an unauthenticated POST that
 *    upgrades any account to any plan;
 *  - applying the same event twice, which webhooks guarantee will happen,
 *    because delivery is at-least-once and a retry after a slow response is
 *    the normal case rather than the odd one.
 *
 *  `stripeSignature.test.ts` already covers the HMAC itself. This file is
 *  about the route around it: that it reads the raw bytes, that it does not
 *  say which half of a check failed, and that an unconfigured deployment
 *  accepts nothing at all.
 */

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/env.js")>();
  Object.assign(settings, actual.env);
  return { ...actual, env: settings };
});

const applySubscription = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const claimEvent = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("../../service/billingService.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/billingService.js")>();
  // `toStatus` is deliberately the real one: the mapping from a processor's
  // vocabulary to this product's four statuses is the part of the payload
  // reading that could quietly go wrong.
  return { ...actual, applySubscription, claimEvent };
});

const subscriptionFindUnique = vi.hoisted(() =>
  vi.fn((): Promise<{ userId: string } | null> => Promise.resolve(null)),
);
vi.mock("../../lib/prisma.js", () => ({
  prisma: { subscription: { findUnique: subscriptionFindUnique } },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import billingRouter from "./billing.js";
import { errorHandler } from "../../middlewares/errorHandler.js";

const SECRET = "whsec_test";
const USER = "11111111-1111-4111-8111-111111111111";

function app() {
  const instance = express();
  // Note what is NOT here: `express.json()`. The route brings its own
  // `express.raw`, and mounting a JSON parser in front of it is precisely the
  // bug that would make every real delivery fail its signature -- so the test
  // app is assembled the way the real one is.
  instance.use("/billing", billingRouter);
  instance.use(errorHandler);
  return instance;
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { userId: USER, planId: "pro" },
        ...overrides,
      },
    },
  });
}

function sign(body: string, secret = SECRET, at = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${String(t)}.${body}`).digest("hex");
  return `t=${String(t)},v1=${v1}`;
}

function post(body: string, header?: string) {
  const call = request(app())
    .post("/billing/webhook")
    .set("content-type", "application/json");
  if (header !== undefined) call.set("stripe-signature", header);
  return call.send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  settings["STRIPE_WEBHOOK_SECRET"] = SECRET;
  applySubscription.mockResolvedValue(undefined);
  claimEvent.mockResolvedValue(true);
  subscriptionFindUnique.mockResolvedValue(null);
});

describe("a signed event", () => {
  it("is applied", async () => {
    const body = event();

    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, planId: "pro", status: "ACTIVE" }),
    );
  });

  /** The processor's vocabulary is bigger than this product's, and the
   *  direction that matters is not granting a paid plan to somebody whose
   *  first payment has not cleared. */
  it("carries the processor's status through the one mapping there is", async () => {
    const body = event({ status: "past_due" });

    await post(body, sign(body));

    expect(applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAST_DUE" }),
    );
  });

  /** An account is found by the customer id the checkout wrote, so a later
   *  event whose metadata has been lost still lands on the right account. */
  it("finds the account by its customer id when it already has one", async () => {
    subscriptionFindUnique.mockResolvedValue({ userId: USER });
    const body = event({ metadata: { planId: "pro" } });

    await post(body, sign(body));

    expect(applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
    );
  });
});

describe("an event that cannot be trusted", () => {
  it("is refused when the signature does not match", async () => {
    const body = event();

    const response = await post(body, sign(body, "whsec_someone_else"));

    expect(response.status).toBe(400);
    expect(applySubscription).not.toHaveBeenCalled();
  });

  it("is refused when there is no signature at all", async () => {
    const response = await post(event());

    expect(response.status).toBe(400);
    expect(applySubscription).not.toHaveBeenCalled();
  });

  /** The body is the thing that was signed. If the route ever parsed and
   *  re-serialized before verifying, this is the test that would still pass
   *  while every real delivery failed -- so it asserts on bytes a
   *  round-trip would change. */
  it("verifies the bytes that arrived, not a re-serialization of them", async () => {
    const body = '{"id": "evt_1", "type": "customer.subscription.deleted", "data": {"object": {}}}';
    expect(JSON.stringify(JSON.parse(body) as unknown)).not.toBe(body);

    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
  });

  /** An endpoint that says which half of the check failed is an oracle for
   *  guessing the other half. */
  it("says the same thing however it was forged", async () => {
    const body = event();
    const wrongSecret = await post(body, sign(body, "whsec_someone_else"));
    const replayed = await post(
      body,
      sign(body, SECRET, new Date(Date.now() - 10 * 60 * 1000)),
    );

    expect(wrongSecret.body).toEqual(replayed.body);
    expect(wrongSecret.body.code).toBe("BAD_SIGNATURE");
  });
});

describe("a deployment with no signing secret", () => {
  /** It cannot tell a real event from a forged one, so it accepts neither.
   *  The failure that would matter here is treating an unset secret as one
   *  that everything matches. */
  it("accepts nothing, correctly signed or not", async () => {
    settings["STRIPE_WEBHOOK_SECRET"] = undefined;
    const body = event();

    const response = await post(body, sign(body));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("BILLING_NOT_CONFIGURED");
    expect(applySubscription).not.toHaveBeenCalled();
  });

  it("says so on the status endpoint rather than claiming it can sell", async () => {
    settings["STRIPE_WEBHOOK_SECRET"] = undefined;

    const response = await request(app()).get("/billing/status");

    expect(response.body.data.webhookConfigured).toBe(false);
    // Never true in this pass: nothing here can create a Checkout session,
    // and a screen that offered one would be offering a button that fails.
    expect(response.body.data.checkoutConfigured).toBe(false);
  });
});

describe("the same event delivered twice", () => {
  /** Delivery is at-least-once, and a retry after a slow response is the
   *  normal case. The second copy must not buy anything. */
  it("is applied once and acknowledged both times", async () => {
    claimEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const body = event();

    const first = await post(body, sign(body));
    const second = await post(body, sign(body));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(applySubscription).toHaveBeenCalledTimes(1);
  });
});

describe("an event this product does not act on", () => {
  /** 200 deliberately. A processor retries anything else, and retrying an
   *  event nobody will ever handle is a queue that never drains. */
  it("is acknowledged rather than retried forever", async () => {
    const body = event();
    const other = body.replace("customer.subscription.updated", "invoice.paid");

    const response = await post(other, sign(other));

    expect(response.status).toBe(200);
    expect(applySubscription).not.toHaveBeenCalled();
  });

  /** Both halves come from metadata written when the subscription was
   *  created. Guessing either would be worse than doing nothing. */
  it("is ignored when it names no account or no plan", async () => {
    for (const metadata of [{}, { userId: USER }, { planId: "pro" }]) {
      const body = event({ metadata });

      const response = await post(body, sign(body));

      expect(response.status).toBe(200);
    }

    expect(applySubscription).not.toHaveBeenCalled();
  });

  it("is refused when the payload is not readable at all", async () => {
    const body = "not json";

    const response = await post(body, sign(body));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("BAD_EVENT");
  });
});
