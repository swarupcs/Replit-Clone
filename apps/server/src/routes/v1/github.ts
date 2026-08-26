import express from "express";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import {
  githubConnectCallback,
  githubConnectStart,
  githubConnectionStatus,
  githubDisconnect,
} from "../../controllers/githubController.js";

const router = express.Router();

router.get("/status", requireAuth, asyncHandler(githubConnectionStatus));
router.post("/connect", requireAuth, asyncHandler(githubConnectStart));

// No `requireAuth`: this is GitHub redirecting the browser back, so there is no
// Authorization header to carry. Who it belongs to comes from the signed actor
// cookie the start endpoint set, and the `state` cookie is what makes the round
// trip verifiable at all.
router.get("/callback", asyncHandler(githubConnectCallback));

router.delete("/connection", requireAuth, asyncHandler(githubDisconnect));

export default router;
