import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import {
  readEmbedController,
  readEmbedFileController,
} from "../../controllers/embedController.js";

/** The two endpoints an embedded iframe calls, with nobody signed in.
 *
 *  Mounted as its own router rather than under `/projects` for one reason worth
 *  being explicit about: `/projects` does `router.use(requireAuth)` at the top,
 *  so anything added there is authenticated whether its author thought about it
 *  or not. That default is right, and the way to keep it right is to put the
 *  exceptions somewhere they cannot be mistaken for the rule.
 *
 *  The owner's endpoints — create, update, revoke — live under `/projects`
 *  behind that same `requireAuth`, where they belong.
 */
const router = express.Router();

/** A budget, because this is a public endpoint that reads the disk.
 *
 *  Generous per window: one reader opening an embed and clicking through a
 *  dozen files is the normal case, and a limit that punishes them is a limit
 *  that broke the feature. What it stops is the other thing — an unauthenticated
 *  endpoint being walked, either to enumerate tokens or simply to make the
 *  server do filesystem work for free.
 */
const embedLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests. Try again in a few minutes.",
  },
});

router.use(embedLimiter);

router.get("/:token", asyncHandler(readEmbedController));
router.get("/:token/file", asyncHandler(readEmbedFileController));

export default router;
