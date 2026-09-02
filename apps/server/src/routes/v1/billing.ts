import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { increment } from "../../lib/metrics.js";
import { verifyStripeSignature } from "../../service/stripeSignature.js";
import {
  applySubscription,
  claimEvent,
  toStatus,
} from "../../service/billingService.js";
import { prisma } from "../../lib/prisma.js";

/** The processor's side of billing.
 *
 *  §9.4 builds everything except the two calls that need a key somebody else
 *  owns. What that leaves is the half that actually decides what an account is
 *  allowed to do, and the half that has to be right before any money moves:
 *
 *  - **The webhook is the only writer of subscription state.** The
 *    post-checkout redirect is a browser event — droppable, replayable, and
 *    reachable by somebody who never paid. Granting a plan on redirect is what
 *    most tutorials show. §6 decision 13: the guarantee lives where it cannot
 *    be skipped.
 *  - **Checkout and Portal are not here**, and the endpoint below says so
 *    rather than failing in an interesting way. They are two calls to a live
 *    API; writing them against no account would be writing code that has never
 *    run and cannot be tested, which is not what this codebase does.
 */

/** Unauthenticated, like every webhook: the sender has a signature, not a
 *  session. Limited anyway — an endpoint that does an HMAC per request is a
 *  free way to spend this server's CPU. */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "",
});

const router = express.Router();

/** What this deployment can do about money.
 *
 *  Configured means a signing secret exists. Nothing here reports whether
 *  Checkout works, because nothing here can create a Checkout session — see
 *  the note above, and plan.md §9.4.
 */
router.get("/status", (_req, res) => {
  res.json({
    success: true,
    message: "Billing",
    data: {
      // The webhook is the only writer of subscription state, so this bit is
      // the honest answer to "can this deployment sell anything": without it,
      // no subscription can ever be granted, however the checkout went.
      webhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
      checkoutConfigured: false,
    },
  });
});

/** One event from the processor.
 *
 *  `express.raw` and not `express.json`: the signature covers the bytes that
 *  were sent, and a parse-then-restringify produces a different string that
 *  fails every time. The route is mounted before the JSON parser for the same
 *  reason, exactly as the preview proxy is.
 */
router.post(
  "/webhook",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;

    // A deployment with no secret cannot tell a real event from a forged one,
    // so it accepts neither. 503 and not 404: the endpoint exists and is
    // unconfigured, which is a different thing for whoever is looking at a
    // processor's delivery log.
    if (!secret) {
      increment("billing_webhook_rejected");
      res.status(503).json({
        success: false,
        code: "BILLING_NOT_CONFIGURED",
        message: "This deployment has no billing signing secret.",
      });
      return;
    }

    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const header = req.get("stripe-signature") ?? "";

    const verified = verifyStripeSignature(raw, header, secret);
    if (!verified.ok) {
      increment("billing_webhook_rejected");
      // The reason is logged and never returned. An endpoint that says which
      // half of the check failed is an oracle for guessing the other half.
      logger.warn("rejected a billing webhook", { reason: verified.reason });
      res.status(400).json({
        success: false,
        code: "BAD_SIGNATURE",
        message: "Signature check failed.",
      });
      return;
    }

    const event = parse(raw);
    if (!event) {
      res.status(400).json({
        success: false,
        code: "BAD_EVENT",
        message: "Unreadable event.",
      });
      return;
    }

    // At-least-once delivery: the second copy loses to a unique index rather
    // than to a race between two workers.
    if (!(await claimEvent(event.id, event.type))) {
      res.json({ success: true, message: "Already handled", data: null });
      return;
    }

    const update = await toUpdate(event);
    if (update) await applySubscription(update);

    // 200 for an event this product does not act on, deliberately. A processor
    // retries anything else, and retrying an event nobody will ever handle is
    // a queue that never drains.
    res.json({ success: true, message: "Handled", data: null });
  }),
);

interface ProcessorEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function parse(raw: string): ProcessorEvent | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ProcessorEvent>;
    if (typeof value.id !== "string" || typeof value.type !== "string") return undefined;
    if (!value.data || typeof value.data !== "object") return undefined;
    return value as ProcessorEvent;
  } catch {
    return undefined;
  }
}

/** Which events change what an account is allowed, and what they say.
 *
 *  A deliberately short list. Stripe sends dozens; the ones that decide
 *  entitlement are the subscription's own lifecycle, and reading anything else
 *  would be inferring state from a payment rather than from the subscription
 *  that payment belongs to.
 */
async function toUpdate(event: ProcessorEvent) {
  if (!event.type.startsWith("customer.subscription.")) return undefined;

  const object = event.data.object;
  const customerId = typeof object["customer"] === "string" ? object["customer"] : null;
  const subscriptionId = typeof object["id"] === "string" ? object["id"] : null;
  const status = typeof object["status"] === "string" ? object["status"] : "canceled";

  // `client_reference_id` is not on a subscription, so the account has to be
  // found by the customer id the checkout wrote. An event for a customer this
  // deployment has never seen is not an error -- one processor account can
  // serve more than one deployment -- so it is ignored rather than failed.
  const existing = customerId
    ? await prisma.subscription.findUnique({
        where: { customerId },
        select: { userId: true },
      })
    : null;

  const metadata = object["metadata"];
  const userId =
    existing?.userId ??
    (typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)["userId"]
      : undefined);

  const planId =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)["planId"]
      : undefined;

  if (typeof userId !== "string" || typeof planId !== "string") {
    // Both come from metadata set when the subscription was created. Without
    // them there is no way to know whose plan this is or which plan it is, and
    // guessing either would be worse than doing nothing.
    logger.warn("billing event named no account or plan", { type: event.type });
    return undefined;
  }

  const periodEnd = object["current_period_end"];

  return {
    userId,
    planId,
    status: toStatus(status),
    customerId,
    subscriptionId,
    currentPeriodEnd:
      typeof periodEnd === "number" ? new Date(periodEnd * 1000) : null,
  };
}

export default router;
