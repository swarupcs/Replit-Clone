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
  downloadFileController,
  MAX_UPLOAD_BYTES,
  uploadFilesController,
} from "../../controllers/fileTransferController.js";

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
router.put("/:projectId/env", asyncHandler(setProjectEnvController));
router.delete("/:projectId", asyncHandler(deleteProjectController));

export default router;
