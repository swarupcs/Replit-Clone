import express from "express";
import { pingCheck } from "../../controllers/pingController.js";
import { metricsReport } from "../../controllers/healthController.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import authRouter from "./auth.js";
import projectRouter from "./projects.js";

const router = express.Router();

// Wrapped like every other async handler: Express 4 does not await these, so a
// rejection would otherwise leave the request hanging.
router.get("/ping", asyncHandler(pingCheck));

// Behind auth: counters describe how busy the deployment is and what is
// failing, which is not for anyone who can reach the port.
router.get("/metrics", requireAuth, asyncHandler(metricsReport));
router.use("/auth", authRouter);
router.use("/projects", projectRouter);

export default router;
