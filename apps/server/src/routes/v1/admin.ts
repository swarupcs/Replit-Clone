import express from "express";
import { requireAdmin } from "../../middlewares/requireAdmin.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import {
  listReportsController,
  reviewReportController,
} from "../../controllers/reportController.js";

/** The operator's surface. Small on purpose.
 *
 *  Two routes, and the only authority either of them grants is to take a
 *  project out of the gallery. An operator here cannot delete a project, edit
 *  one, or touch an account — the smallest power that resolves a complaint,
 *  and the one whose mistakes the person they were made against can undo.
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

export default router;
