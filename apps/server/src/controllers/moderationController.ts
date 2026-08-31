import type { Request, Response } from "express";
import { z } from "zod";
import { MAX_APPEAL, MAX_MODERATION_REASON } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import {
  appealTakedown,
  listModerationActions,
  listRecentModeration,
  reinstateProject,
} from "../service/moderationLogService.js";

const appealSchema = z.object({
  text: z.string().trim().min(1).max(MAX_APPEAL),
});

const reinstateSchema = z.object({
  reason: z.string().trim().min(1).max(MAX_MODERATION_REASON),
});

/** The owner appealing a takedown of their own project. */
export async function appealController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const { userId } = getAuthContext(req);
  const { text } = appealSchema.parse(req.body ?? {});

  const action = await appealTakedown({ projectId, ownerId: userId, text });

  res.status(201).json({
    success: true,
    message: "Appeal filed.",
    data: { action },
  });
}

/** One project's moderation trail.
 *
 *  Readable by the project's OWNER, which is the point rather than a
 *  convenience: a record of decisions taken against somebody that only the
 *  decider can read is not accountability. Operators read the same entries
 *  through the admin route.
 *
 *  Owner rather than editor. The trail carries what a moderator wrote about
 *  the project and what the owner wrote back, and being trusted to edit files
 *  is not the same as being party to that.
 */
export async function projectModerationController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "owner");

  res.json({
    success: true,
    message: "Moderation history",
    data: { actions: await listModerationActions(projectId) },
  });
}

/** Everything recent, for an operator. */
export async function recentModerationController(
  req: Request,
  res: Response,
): Promise<void> {
  res.json({
    success: true,
    message: "Moderation history",
    data: await listRecentModeration(req.query),
  });
}

/** An operator lifting a takedown. */
export async function reinstateController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const { email } = getAuthContext(req);
  const { reason } = reinstateSchema.parse(req.body ?? {});

  const action = await reinstateProject({ projectId, actor: email, reason });

  res.json({
    success: true,
    message: "Project reinstated.",
    data: { action },
  });
}
