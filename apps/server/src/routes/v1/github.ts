import express from "express";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import githubWebhookRouter from "./githubWebhook.js";
import {
  enrolPullRequestRepoController,
  listPullRequestReposController,
  removePullRequestRepoController,
} from "../../controllers/pullRequestRepoController.js";
import {
  githubConnectCallback,
  githubConnectStart,
  githubConnectionStatus,
  githubDisconnect,
  githubImportController,
  githubReposController,
} from "../../controllers/githubController.js";

const router = express.Router();

// Mounted FIRST and without `requireAuth`: GitHub has a signature, not a
// session. It is its own router so the raw-body requirement stays visible in
// one file. plan.md §13.3.
router.use("/", githubWebhookRouter);

router.get("/status", requireAuth, asyncHandler(githubConnectionStatus));
router.post("/connect", requireAuth, asyncHandler(githubConnectStart));

// No `requireAuth`: this is GitHub redirecting the browser back, so there is no
// Authorization header to carry. Who it belongs to comes from the signed actor
// cookie the start endpoint set, and the `state` cookie is what makes the round
// trip verifiable at all.
router.get("/callback", asyncHandler(githubConnectCallback));

router.delete("/connection", requireAuth, asyncHandler(githubDisconnect));

router.get("/repos", requireAuth, asyncHandler(githubReposController));
router.post("/import", requireAuth, asyncHandler(githubImportController));

// Which repositories may have pull request workspaces on this account. §13.3.
router.get("/pr-repos", requireAuth, asyncHandler(listPullRequestReposController));
router.post("/pr-repos", requireAuth, asyncHandler(enrolPullRequestRepoController));
router.delete(
  "/pr-repos/:owner/:repo",
  requireAuth,
  asyncHandler(removePullRequestRepoController),
);

export default router;
