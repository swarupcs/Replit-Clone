import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { searchAllProjectsController } from "../../controllers/searchController.js";

/** Searching across projects rather than inside one.
 *
 *  A router of its own, and not a route on `/projects`, because it is scoped
 *  by the auth context rather than by a project id — the distinction the
 *  parent router already draws for `/account` and `/notifications`, where the
 *  absence of an id in the path is the scoping.
 *
 *  Mounted behind `requireAuth` in the parent.
 */
const router = express.Router();

/** Tighter than the per-project search, because it costs more.
 *
 *  A single request here opens up to twenty-five worker threads and walks
 *  twenty-five directory trees. The socket's per-project search has a token
 *  budget for the same reason; this is the same idea for a surface that has no
 *  socket to hold the budget on.
 *
 *  Thirty a minute is far more than a person types and far less than a loop
 *  runs, which is the band a limit like this wants to sit in: nobody searching
 *  by hand will ever see it.
 */
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many searches. Try again in a moment.",
  },
});

router.get("/", searchLimiter, asyncHandler(searchAllProjectsController));

export default router;
