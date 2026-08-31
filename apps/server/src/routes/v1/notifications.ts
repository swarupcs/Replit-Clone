import express from "express";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import {
  listNotificationsController,
  markNotificationsReadController,
} from "../../controllers/notificationController.js";

/** Somebody's own notifications.
 *
 *  No project in the path and no id in the query: every route here is scoped
 *  to the caller by the auth context, which is the only scoping that cannot be
 *  forgotten. Mounted behind `requireAuth` in the parent router.
 */
const router = express.Router();

router.get("/", asyncHandler(listNotificationsController));
router.post("/read", asyncHandler(markNotificationsReadController));

export default router;
