import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import {
  createProjectController,
  deleteProjectController,
  duplicateProjectController,
  exportProjectController,
  getProjectEnvController,
  getStartCommandController,
  setStartCommandController,
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
  githubCreatePullController,
  githubPullsController,
  githubRepoController,
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
import {
  addPackageController,
  listPackagesController,
  removePackageController,
} from "../../controllers/packageController.js";
import {
  deployController,
  getDeploymentController,
  undeployController,
} from "../../controllers/deployController.js";
import { getDevcontainerController } from "../../controllers/devcontainerController.js";
import {
  createEmbedController,
  getEmbedController,
  revokeEmbedController,
  updateEmbedController,
} from "../../controllers/embedController.js";

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

// Installing reaches a registry from inside the sandbox and can run for a
// long time, so it gets a budget separate from ordinary reads. Generous enough
// that adding a handful of dependencies in a sitting never trips it.
const installLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many install requests. Try again in a few minutes.",
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

// Pull requests. Project-scoped because which repository they belong to comes
// from the project's own remotes, not from the request.
// Dependencies. Reading the manifest does not need a container; adding and
// removing run the project's own package manager inside one.
router.get("/:projectId/packages", asyncHandler(listPackagesController));
router.post(
  "/:projectId/packages",
  installLimiter,
  asyncHandler(addPackageController),
);
router.delete(
  "/:projectId/packages",
  installLimiter,
  asyncHandler(removePackageController),
);

// Deployments. A build runs a full install and a bundler inside the container
// and then writes to a disk nothing reclaims on its own, so it gets the
// tightest budget of anything here.
const deployLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many deploys. Try again later.",
  },
});

router.get("/:projectId/deployment", asyncHandler(getDeploymentController));
router.post(
  "/:projectId/deployment",
  deployLimiter,
  asyncHandler(deployController),
);
router.delete("/:projectId/deployment", asyncHandler(undeployController));

// What the project's own .devcontainer/devcontainer.json asked for, and what
// this server did with it.
router.get("/:projectId/devcontainer", asyncHandler(getDevcontainerController));

// Embeds. The OWNER's half only -- what an anonymous reader calls lives on
// its own router, outside the `requireAuth` above.
router.get("/:projectId/embed", asyncHandler(getEmbedController));
router.post("/:projectId/embed", asyncHandler(createEmbedController));
router.patch("/:projectId/embed", asyncHandler(updateEmbedController));
router.delete("/:projectId/embed", asyncHandler(revokeEmbedController));

router.get("/:projectId/start-command", asyncHandler(getStartCommandController));
router.put("/:projectId/start-command", asyncHandler(setStartCommandController));

router.get("/:projectId/github/repo", asyncHandler(githubRepoController));
router.get("/:projectId/github/pulls", asyncHandler(githubPullsController));
router.post(
  "/:projectId/github/pulls",
  asyncHandler(githubCreatePullController),
);
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
