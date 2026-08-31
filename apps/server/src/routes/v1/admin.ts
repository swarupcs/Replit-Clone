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
import {
  accountDetailController,
  machineStatusController,
  recentAccountActionsController,
  searchAccountsController,
  setAccountOverrideController,
  setAccountPlanController,
} from "../../controllers/accountAdminController.js";

/** The operator's surface. Small on purpose, and it grew once, deliberately.
 *
 *  The authority over PROJECTS is still only over whether one is public: an
 *  operator cannot delete a project or edit one. §8.7 added authority over
 *  ACCOUNTS — moving one between plans, and setting limits for it by hand —
 *  which is the first power here that acts on a person rather than on a thing
 *  they made. §6 decision 11 says that must not happen until something reviews
 *  it, so every write on that half records itself with a required reason in
 *  the same transaction, and tells the account holder.
 *
 *  Suspension was considered and refused. Locking somebody out of their own
 *  work is a far larger power than making a project private, and decision 11's
 *  argument is that the authority stays the smallest one that resolves a
 *  complaint.
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

// Accounts. Reading is a lookup; both writes take a reason and record it.
router.get("/accounts", asyncHandler(searchAccountsController));
router.get("/accounts/actions", asyncHandler(recentAccountActionsController));
router.get("/accounts/:userId", asyncHandler(accountDetailController));
router.post("/accounts/:userId/plan", asyncHandler(setAccountPlanController));
router.post(
  "/accounts/:userId/override",
  asyncHandler(setAccountOverrideController),
);

// "Is this machine full?" -- the question the three-container cap makes an
// operator ask most often, and which no screen could answer until now.
router.get("/machine", asyncHandler(machineStatusController));

export default router;
