import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import {
  getApiKeyContext,
  requireApiKey,
  requireScope,
} from "../../middlewares/requireApiKey.js";
import { listAccessibleProjects } from "../../service/projectAccessService.js";
import { assertProjectAccess } from "../../service/projectAccessService.js";
import { createProjectService } from "../../service/projectService.js";
import { publish } from "../../service/deployService.js";
import { getAccountSummary } from "../../service/accountService.js";
import { assertValidProjectId } from "../../utils/projectPaths.js";
import { z } from "zod";

/** The surface an API key can reach, and the whole of it.
 *
 *  This router is the enforcement, not a convenience. A key deliberately does
 *  not authenticate anywhere else in the product: it lives on a CI runner for
 *  months where nobody is watching it, so giving it the signed-in surface
 *  would mean a leaked secret can delete every project, read every environment
 *  variable and change what the account pays for. Instead the reachable set is
 *  four endpoints written out here, and a route that is not in this file is
 *  not reachable by a key at all — a guarantee nobody can forget to apply.
 *
 *  Two exclusions are worth naming because somebody will want them:
 *
 *  **A key cannot manage keys.** Minting and revoking live on the session-only
 *  account router. A stolen key that could issue itself a fresh one with wider
 *  scopes would make revocation theatre.
 *
 *  **A key cannot delete anything.** There is no CI story that needs it, and
 *  the failure mode of getting it wrong is unrecoverable — see §3.3, which
 *  records that this platform has no backups.
 */
const router = express.Router();

router.use(requireApiKey);

/** Machines retry, and a loop with a key in it is the thing most likely to
 *  discover that nothing here was budgeted. Reads get a wide allowance;
 *  anything that spends a container gets the narrow one. */
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many requests from this key. Try again later.",
  },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    message: "Too many writes from this key. Try again later.",
  },
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  template: z.string().trim().min(1).max(80).optional(),
});

router.get(
  "/projects",
  readLimiter,
  requireScope("projects:read"),
  asyncHandler(async (req, res) => {
    const { userId } = getApiKeyContext(req);
    // Paged, and here the cursor is exposed rather than followed for the
    // caller: a script is the one consumer that can be trusted to loop, and
    // the alternative -- one response holding every project an account owns --
    // is the request most likely to be made in a cron job every minute.
    res.json({
      success: true,
      message: "Projects",
      data: await listAccessibleProjects(userId, req.query),
    });
  }),
);

/** Where this account stands against its plan. A key that can create projects
 *  should be able to find out that the next one will be refused, rather than
 *  discovering it from a 429 in the middle of a pipeline. */
router.get(
  "/account",
  readLimiter,
  requireScope("projects:read"),
  asyncHandler(async (req, res) => {
    const { userId } = getApiKeyContext(req);
    res.json({ success: true, message: "Account", data: await getAccountSummary(userId) });
  }),
);

router.post(
  "/projects",
  writeLimiter,
  requireScope("projects:write"),
  asyncHandler(async (req, res) => {
    const { userId } = getApiKeyContext(req);
    const body = createSchema.parse(req.body ?? {});

    const project = await createProjectService(userId, body.name, body.template);
    res.status(201).json({ success: true, message: "Project created", data: project });
  }),
);

/** Publishing an existing project — the reason most people want a key at all.
 *
 *  The access level is named here rather than defaulted, like every other
 *  write in the product: publishing decides what strangers are served, so it
 *  is the owner's. `publish` then makes its own checks, the takedown among
 *  them, exactly as it does for the session route.
 */
router.post(
  "/projects/:projectId/deployment",
  writeLimiter,
  requireScope("deploy"),
  asyncHandler(async (req, res) => {
    const { userId } = getApiKeyContext(req);
    const projectId = assertValidProjectId(req.params.projectId ?? "");

    await assertProjectAccess(projectId, userId, "owner");
    res.json({ success: true, message: "Deploying", data: await publish(projectId) });
  }),
);

export default router;
