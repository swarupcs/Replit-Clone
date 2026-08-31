import express from "express";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { accountSummaryController } from "../../controllers/accountController.js";

/** Somebody's own account: what they are using, and what they are allowed.
 *
 *  One endpoint rather than three, because the three are only meaningful
 *  together — a number, its limit, and what is responsible for it. Mounted
 *  behind `requireAuth` in the parent router.
 */
const router = express.Router();

router.get("/", asyncHandler(accountSummaryController));

export default router;
