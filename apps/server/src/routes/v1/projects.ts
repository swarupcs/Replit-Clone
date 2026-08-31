import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createPublishLimiter } from "../../utils/publishBudget.js";
import { reportProjectController } from "../../controllers/reportController.js";
import {
  appealController,
  projectModerationController,
} from "../../controllers/moderationController.js";
import {
  getTestCommandController,
  runTestsController,
  setTestCommandController,
} from "../../controllers/testRunController.js";
import {
  createProjectController,
  deleteProjectController,
  duplicateProjectController,
  forkProjectController,
  listPublicProjectsController,
  setVisibilityController,
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
import {
  databaseQueryController,
  databaseSchemaController,
  databaseTableController,
  getDatabaseConnectionController,
  removeDatabaseConnectionController,
  setDatabaseConnectionController,
  getManagedDatabaseController,
  provisionManagedDatabaseController,
  destroyManagedDatabaseController,
  mongoCollectionsController,
  mongoCollectionSchemaController,
  mongoQueryController,
} from "../../controllers/databaseController.js";
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
  claimDomainController,
  deployController,
  releaseDomainController,
  verifyDomainController,
  getDeploymentController,
  undeployController,
  listReleasesController,
  rollbackController,
} from "../../controllers/deployController.js";
import {
  createJobController,
  deleteJobController,
  listJobsController,
  listRunsController,
  runJobController,
  updateJobController,
} from "../../controllers/scheduleController.js";
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
// The gallery. Before "/:projectId/..." routes so "public" is never read as an
// id -- and readable by anybody signed in, since it lists only what its owners
// have already published.
router.get("/public", asyncHandler(listPublicProjectsController));
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

// The builds this project has published, and going back to one. Reading is a
// viewer's; rolling back is the owner's, because it changes what strangers get
// at a public address -- the same decision as publishing, in the other
// direction.
router.get("/:projectId/releases", asyncHandler(listReleasesController));
router.post(
  "/:projectId/releases/:releaseId/rollback",
  asyncHandler(rollbackController),
);

// Verification is rate limited and claiming is not. Claiming writes one row
// the owner already owns; verifying makes an outbound DNS query per press,
// which is somebody else's resolver being asked a question on our behalf.
const domainVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many verification attempts. Wait a minute and try again.",
  },
});

router.put("/:projectId/deployment/domain", asyncHandler(claimDomainController));
router.post(
  "/:projectId/deployment/domain/verify",
  domainVerifyLimiter,
  asyncHandler(verifyDomainController),
);
router.delete(
  "/:projectId/deployment/domain",
  asyncHandler(releaseDomainController),
);

// Scheduled jobs. Reading is a viewer's; everything that changes what runs, or
// runs it now, is the owner's -- see the controller for why that is not an
// editor's.
//
// "Run now" carries the limiter and nothing else does, because it is the only
// one of these that starts a container. Saving a job writes a row; pressing the
// button is a build's worth of work on demand.
const jobRunLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many manual runs. Try again later.",
  },
});

router.get("/:projectId/jobs", asyncHandler(listJobsController));
router.post("/:projectId/jobs", asyncHandler(createJobController));
router.patch("/:projectId/jobs/:jobId", asyncHandler(updateJobController));
router.delete("/:projectId/jobs/:jobId", asyncHandler(deleteJobController));
router.get("/:projectId/jobs/:jobId/runs", asyncHandler(listRunsController));
router.post(
  "/:projectId/jobs/:jobId/run",
  jobRunLimiter,
  asyncHandler(runJobController),
);

// The query editor. Rate limited on the same reasoning as installs and
// deploys: each request holds a database connection open for as long as the
// statement runs, and the statement is somebody else's to write.
const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many queries. Try again in a moment.",
  },
});

router.get("/:projectId/database", asyncHandler(getDatabaseConnectionController));
router.put("/:projectId/database", asyncHandler(setDatabaseConnectionController));
router.delete(
  "/:projectId/database",
  asyncHandler(removeDatabaseConnectionController),
);
router.get(
  "/:projectId/database/managed",
  asyncHandler(getManagedDatabaseController),
);
router.post(
  "/:projectId/database/managed",
  deployLimiter,
  asyncHandler(provisionManagedDatabaseController),
);
router.delete(
  "/:projectId/database/managed",
  asyncHandler(destroyManagedDatabaseController),
);
router.get("/:projectId/database/schema", asyncHandler(databaseSchemaController));
router.get("/:projectId/database/table", asyncHandler(databaseTableController));
router.get(
  "/:projectId/database/collections",
  asyncHandler(mongoCollectionsController),
);
router.get(
  "/:projectId/database/collection-schema",
  asyncHandler(mongoCollectionSchemaController),
);
router.post(
  "/:projectId/database/query",
  queryLimiter,
  asyncHandler(databaseQueryController),
);
router.post(
  "/:projectId/database/mongo-query",
  queryLimiter,
  asyncHandler(mongoQueryController),
);

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
// Forking a PUBLIC project needs no invitation from anybody, which is the
// whole point of it -- so it is rate limited like any other project creation.
router.post("/:projectId/fork", createLimiter, asyncHandler(forkProjectController));
// Publishing a project puts it in a gallery every signed-in user can read, so
// it is the one action here whose cost lands on people other than the person
// taking it. Forking was already rate limited (as project creation) and
// publishing never was.
//
// Only in the publishing direction -- see `countsAgainstPublishBudget`, which
// is where that asymmetry is explained and tested.
//
// The other half -- reporting and review -- shipped later, once there was a
// decision about who reviews: an `ADMIN_EMAILS` allowlist. See
// middlewares/requireAdmin.ts and routes/v1/admin.ts.
const publishLimiter = createPublishLimiter();

// Reporting is rate limited for the same reason publishing is, and for one
// more. A report costs an operator's attention rather than a machine's, and
// the review queue is the scarce resource here -- somebody who can file a
// hundred reports an hour can bury every other complaint on the page. The
// per-account duplicate rule in `fileReport` stops the same project being
// reported twice; this stops a hundred DIFFERENT projects being reported in a
// minute.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many reports filed. Try again later.",
  },
});

router.patch(
  "/:projectId/visibility",
  publishLimiter,
  asyncHandler(setVisibilityController),
);
router.post(
  "/:projectId/report",
  reportLimiter,
  asyncHandler(reportProjectController),
);

// Tests. Reading the command is a viewer's, running it needs the same grant
// `Run` does, and changing it is the owner's -- see the controller.
//
// The limiter is here for the reason `jobRunLimiter` is on "run now": this is
// the second route in the product that starts a container on demand, and the
// argument written down for the first applies to it word for word. Same
// budget, deliberately -- one person's manual runs, of either kind, are the
// same cost to this machine.
const testRunLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many test runs. Try again later.",
  },
});

router.get("/:projectId/test-command", asyncHandler(getTestCommandController));
router.put("/:projectId/test-command", asyncHandler(setTestCommandController));
router.post("/:projectId/test", testRunLimiter, asyncHandler(runTestsController));

// The other side of moderation: what was done to this project, and the owner's
// answer to it. Both are the owner's -- a decision taken against somebody that
// only the decider can read is not a record, it is a file.
router.get("/:projectId/moderation", asyncHandler(projectModerationController));
router.post(
  "/:projectId/appeal",
  reportLimiter,
  asyncHandler(appealController),
);

// Export starts no container and is not free either: it walks and zips an
// entire working tree per request, at viewer level, and a project is allowed
// to be gigabytes. Looser than the two container routes because it is a
// smaller cost, tighter than nothing because a loop over it is disk and CPU
// nobody is accounted for.
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many downloads. Try again later.",
  },
});

router.get("/:projectId/export", exportLimiter, asyncHandler(exportProjectController));
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
