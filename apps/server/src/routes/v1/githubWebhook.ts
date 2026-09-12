import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { increment } from "../../lib/metrics.js";
import { verifyGithubSignature } from "../../service/githubSignature.js";
import { decide } from "../../service/pullRequestEvent.js";
import { applyDecision, claimDelivery } from "../../service/prWorkspaceService.js";

/** The receiver for a GitHub App's `pull_request` and `push` events. §13.3.
 *
 *  Before this there was no webhook in the GitHub path at all — the only one in
 *  the tree was the processor's, and reading it as a pattern is how §5's
 *  raw-body defect was found.
 */

/** Unauthenticated, like every webhook: the sender has a signature, not a
 *  session. Limited anyway, because an endpoint that does an HMAC per request
 *  is a free way to spend this server's CPU. */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "",
});

const router = express.Router();

/** One delivery.
 *
 *  The raw body is preserved by `middlewares/webhookRawBody.ts`, mounted before
 *  `express.json()` — the `express.raw` here is a second line that wins only
 *  when this router is mounted without it, as the tests mount it. See §5: the
 *  route-level parser ALONE is what the billing webhook had, and it did not
 *  work.
 */
router.post(
  "/webhook",
  webhookLimiter,
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const secret = env.GITHUB_WEBHOOK_SECRET;

    // 503 and not 404: the endpoint exists and is unconfigured, which is a
    // different thing for whoever is reading an App's delivery log.
    if (!secret) {
      increment("github_webhook_rejected");
      res.status(503).json({
        success: false,
        code: "GITHUB_WEBHOOK_NOT_CONFIGURED",
        message: "This deployment has no GitHub webhook signing secret.",
      });
      return;
    }

    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const header = req.get("x-hub-signature-256") ?? "";

    const verified = verifyGithubSignature(raw, header, secret);
    if (!verified.ok) {
      increment("github_webhook_rejected");
      // Logged, never returned: an endpoint that says which half of the check
      // failed is an oracle for guessing the other half.
      logger.warn("rejected a GitHub webhook", { reason: verified.reason });
      res.status(400).json({
        success: false,
        code: "BAD_SIGNATURE",
        message: "Signature check failed.",
      });
      return;
    }

    const event = req.get("x-github-event") ?? "";
    const delivery = req.get("x-github-delivery") ?? "";

    // No delivery id means this cannot be deduplicated, and the dedupe is the
    // only replay defence a timestamp-less signature leaves — so it is refused
    // rather than acted on once and hoped about.
    if (!delivery) {
      increment("github_webhook_rejected");
      res.status(400).json({
        success: false,
        code: "NO_DELIVERY_ID",
        message: "No delivery id.",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).json({
        success: false,
        code: "BAD_EVENT",
        message: "Unreadable event.",
      });
      return;
    }

    const decision = decide(event, payload);

    // A ping is answered without being recorded: it carries no work, and
    // claiming its id would mean a re-ping after a reconfigure looked like a
    // replay.
    if (decision.kind === "ping") {
      res.json({ success: true, message: "pong", data: null });
      return;
    }

    if (!(await claimDelivery(delivery, event))) {
      res.json({ success: true, message: "Already handled", data: null });
      return;
    }

    const outcome = await applyDecision(decision);

    // 200 for a delivery this product does not act on, deliberately. GitHub
    // retries anything else, and retrying an event nobody will ever handle is a
    // queue that never drains.
    res.json({ success: true, message: outcome, data: null });
  }),
);

export default router;
