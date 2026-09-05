import express from "express";
import { pingCheck } from "../../controllers/pingController.js";
import { metricsReport } from "../../controllers/healthController.js";
import { capabilities } from "../../config/deploymentMode.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { aiStatusController } from "../../controllers/aiController.js";
import authRouter from "./auth.js";
import projectRouter from "./projects.js";
import githubRouter from "./github.js";
import embedRouter from "./embeds.js";
import adminRouter from "./admin.js";
import notificationRouter from "./notifications.js";
import accountRouter from "./account.js";
import searchRouter from "./search.js";
import pubRouter from "./pub.js";
import tlsRouter from "./tls.js";
import billingRouter from "./billing.js";

const router = express.Router();

// Wrapped like every other async handler: Express 4 does not await these, so a
// rejection would otherwise leave the request hanging.
router.get("/ping", asyncHandler(pingCheck));

// Behind auth: counters describe how busy the deployment is and what is
// failing, which is not for anyone who can reach the port.
router.get("/metrics", requireAuth, asyncHandler(metricsReport));
// Behind auth: it names the model this deployment pays for, which is nobody's
// business but a signed-in user's.
router.get("/ai/status", requireAuth, asyncHandler(aiStatusController));

router.use("/auth", authRouter);
router.use("/projects", projectRouter);
router.use("/github", githubRouter);
// Scoped entirely by the auth context -- there is no id in any path here,
// which is the only kind of scoping nobody can forget to apply.
router.use("/notifications", requireAuth, notificationRouter);
// The same, and for the same reason.
router.use("/account", requireAuth, accountRouter);
// And again: this searches every project the CALLER owns, so the account is
// the whole of the scope and there is no id anywhere to get wrong.
router.use("/search", requireAuth, searchRouter);
// Behind requireAuth here, and behind requireAdmin inside. Both: the inner
// guard reads the auth context, so a router that mounted it alone would fail
// as an Unauthorized rather than as the wiring mistake it is.
//
// Not mounted at all in single-user mode. The operator console administers
// ACCOUNTS and reviews reports filed by one person against another; there is
// one account here and it is yours, so every screen behind it is a mirror.
// §6 decision 11 says this authority stays the smallest one that resolves a
// complaint -- and where no complaint can be made, the smallest is none.
if (capabilities().operatorConsole) {
  router.use("/admin", requireAuth, adminRouter);
}
// Deliberately NOT behind requireAuth: this is the API-key surface, and a key
// is not a session. It authenticates itself, and the set of things it can
// reach is the set of routes written in that file -- see routes/v1/pub.ts for
// why that is the enforcement rather than a convenience.
router.use("/pub", pubRouter);

// Deliberately NOT behind requireAuth: a processor has a signature, not a
// session. The route reads the RAW body for that signature, which is why it
// brings its own `express.raw` rather than relying on the app's JSON parser.
router.use("/billing", billingRouter);

// Deliberately NOT behind requireAuth: the TLS terminator asks this before
// any session exists, which is the whole point of it. It answers with a status
// code and nothing else -- see routes/v1/tls.ts for why that is not laziness.
router.use("/tls", tlsRouter);

// Deliberately NOT behind requireAuth: an embed is read by people who have
// no account here and never will. See routes/v1/embeds.ts.
router.use("/embeds", embedRouter);

export default router;
