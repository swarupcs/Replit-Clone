import express from "express";
import { pingCheck } from "../../controllers/pingController.js";
import { metricsReport } from "../../controllers/healthController.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { aiStatusController } from "../../controllers/aiController.js";
import authRouter from "./auth.js";
import projectRouter from "./projects.js";
import githubRouter from "./github.js";
import embedRouter from "./embeds.js";

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
// Deliberately NOT behind requireAuth: an embed is read by people who have
// no account here and never will. See routes/v1/embeds.ts.
router.use("/embeds", embedRouter);

export default router;
