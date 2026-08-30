import express from "express";
import { requireAdmin } from "../../middlewares/requireAdmin.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import {
  listReportsController,
  reviewReportController,
} from "../../controllers/reportController.js";
import {
  recentModerationController,
  reinstateController,
} from "../../controllers/moderationController.js";

/** The operator's surface. Small on purpose.
 *
 *  The only authority here is over whether a project is public. An operator
 *  cannot delete a project, edit one, or touch an account — the smallest power
 *  that resolves a complaint.
 *
 *  This used to add "and the one whose mistakes the person they were made
 *  against can undo". That stopped being true when the takedown was made to
 *  stick (§2.16): the owner cannot publish again. So the mistakes are undone
 *  from this side instead, by `reinstate`, and every decision is now written
 *  down — an unreviewed power is survivable when it leaves a record and has a
 *  route back, and was not before.
 *
 *  Mounted under `requireAuth` by the parent router, then `requireAdmin` here.
 *  Both, in that order: `requireAdmin` reads the auth context and a router
 *  that forgot the first would fail as an Unauthorized rather than as the
 *  wiring mistake it is.
 */
const router = express.Router();

router.use(requireAdmin);

router.get("/reports", asyncHandler(listReportsController));
router.post("/reports/:reportId/review", asyncHandler(reviewReportController));

router.get("/moderation", asyncHandler(recentModerationController));
router.post(
  "/projects/:projectId/reinstate",
  asyncHandler(reinstateController),
);

export default router;
