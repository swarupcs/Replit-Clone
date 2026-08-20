import express from "express";
import { pingCheck } from "../../controllers/pingController.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import authRouter from "./auth.js";
import projectRouter from "./projects.js";

const router = express.Router();

// Wrapped like every other async handler: Express 4 does not await these, so a
// rejection would otherwise leave the request hanging.
router.get("/ping", asyncHandler(pingCheck));
router.use("/auth", authRouter);
router.use("/projects", projectRouter);

export default router;
