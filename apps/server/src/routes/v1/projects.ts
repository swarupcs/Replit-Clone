import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import {
  createProjectController,
  deleteProjectController,
  duplicateProjectController,
  exportProjectController,
  getProjectEnvController,
  getProjectPorts,
  getProjectTree,
  listProjectsController,
  listTemplatesController,
  renameProjectController,
  setProjectEnvController,
} from "../../controllers/projectController.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import {
  createShareLinkController,
  listSharingController,
  previewShareLinkController,
  redeemShareLinkController,
  removeCollaboratorController,
  revokeShareLinkController,
  setCollaboratorController,
} from "../../controllers/sharingController.js";
import {
  downloadFileController,
  MAX_UPLOAD_BYTES,
  uploadFilesController,
} from "../../controllers/fileTransferController.js";
import {
  gitBranchController,
  gitBranchesController,
  gitCommitController,
  gitDiscardController,
  gitFetchController,
  gitHunksController,
  gitPullController,
  gitPushController,
  gitRemoteController,
  gitRemotesController,
  gitDiffController,
  gitInitController,
  gitLogController,
  gitStageController,
  gitStatusController,
  gitUnstageController,
} from "../../controllers/gitController.js";

const router = express.Router();

// Scaffolding a project spawns a process and writes to disk, so it gets a
// budget of its own.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many projects created. Try again later.",
  },
});

/** Uploads are held in memory rather than spooled to a temp directory: they
 *  are bounded below, and a temp file is one more thing to clean up after a
 *  failed request. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 },
});

router.use(requireAuth);

router.get("/templates", asyncHandler(listTemplatesController));
router.get("/", asyncHandler(listProjectsController));
router.post("/", createLimiter, asyncHandler(createProjectController));
router.get("/:projectId/tree", asyncHandler(getProjectTree));
router.get("/:projectId/ports", asyncHandler(getProjectPorts));

// Source control. Every one of these runs git INSIDE the project's container,
// so the repository is handled by the sandbox rather than by the host.
router.get("/:projectId/git/status", asyncHandler(gitStatusController));
router.get("/:projectId/git/diff", asyncHandler(gitDiffController));
router.get("/:projectId/git/log", asyncHandler(gitLogController));
router.get("/:projectId/git/branches", asyncHandler(gitBranchesController));
router.post("/:projectId/git/branch", asyncHandler(gitBranchController));
router.post("/:projectId/git/init", asyncHandler(gitInitController));
router.post("/:projectId/git/stage", asyncHandler(gitStageController));
router.post("/:projectId/git/unstage", asyncHandler(gitUnstageController));
router.post("/:projectId/git/discard", asyncHandler(gitDiscardController));
router.post("/:projectId/git/hunks", asyncHandler(gitHunksController));
router.get("/:projectId/git/remotes", asyncHandler(gitRemotesController));
router.post("/:projectId/git/remote", asyncHandler(gitRemoteController));
router.post("/:projectId/git/fetch", asyncHandler(gitFetchController));
router.post("/:projectId/git/pull", asyncHandler(gitPullController));
router.post("/:projectId/git/push", asyncHandler(gitPushController));
router.post("/:projectId/git/commit", asyncHandler(gitCommitController));
router.patch("/:projectId", asyncHandler(renameProjectController));
router.post("/:projectId/duplicate", createLimiter, asyncHandler(duplicateProjectController));
router.get("/:projectId/export", asyncHandler(exportProjectController));
router.get("/:projectId/env", asyncHandler(getProjectEnvController));
router.post(
  "/:projectId/files",
  upload.array("files", 20),
  asyncHandler(uploadFilesController),
);
router.get("/:projectId/files", asyncHandler(downloadFileController));

// --- Sharing -------------------------------------------------------------
// `share/preview` and `share/redeem` are not scoped to a project id, because
// the caller has a token rather than an id — that is the whole point of a link.
router.get("/share/preview", asyncHandler(previewShareLinkController));
router.post("/share/redeem", asyncHandler(redeemShareLinkController));

router.get("/:projectId/sharing", asyncHandler(listSharingController));
router.put("/:projectId/collaborators", asyncHandler(setCollaboratorController));
router.delete(
  "/:projectId/collaborators/:userId",
  asyncHandler(removeCollaboratorController),
);
router.post("/:projectId/share-link", asyncHandler(createShareLinkController));
router.delete("/:projectId/share-link", asyncHandler(revokeShareLinkController));
router.put("/:projectId/env", asyncHandler(setProjectEnvController));
router.delete("/:projectId", asyncHandler(deleteProjectController));

export default router;
