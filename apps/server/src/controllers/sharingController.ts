import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  getProjectAccess,
  listCollaborators,
  ProjectRole,
  redeemShareToken,
  removeCollaborator,
  revokeShareToken,
  rotateShareToken,
  setCollaborator,
} from "../service/projectAccessService.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const collaboratorSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(["VIEWER", "EDITOR"]),
});

/** What a new share link grants. An EDITOR link is still a named grant:
 *  redeeming adds the signed-in user as a collaborator the owner can see and
 *  demote, so it never becomes an anonymous write credential. */
const shareRoleSchema = z.object({
  role: z.enum(["VIEWER", "EDITOR"]).default("VIEWER"),
});

export async function listSharingController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const { userId } = getAuthContext(req);

  const collaborators = await listCollaborators(projectId, userId);
  const access = await getProjectAccess(projectId, userId);

  res.json({
    success: true,
    message: "Sharing",
    data: {
      level: access?.level ?? "none",
      collaborators,
      // Only the owner is shown the link itself. A viewer knowing the secret
      // would let them re-share the project, which is the owner's call.
      shareToken:
        access?.level === "owner" ? (access.project.shareToken ?? null) : null,
      // What the active link grants, so the owner can see what they handed out.
      shareRole:
        access?.level === "owner" && access.project.shareToken
          ? access.project.shareRole
          : null,
    },
  });
}

export async function setCollaboratorController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const { email, role } = collaboratorSchema.parse(req.body ?? {});

  const added = await setCollaborator(
    projectId,
    getAuthContext(req).userId,
    email,
    role === "EDITOR" ? ProjectRole.EDITOR : ProjectRole.VIEWER,
  );

  logger.info("collaborator set", { projectId, role });

  res.json({ success: true, message: `${email} can now open this project`, data: added });
}

export async function removeCollaboratorController(
  req: Request<{ projectId: string; userId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);

  await removeCollaborator(
    projectId,
    getAuthContext(req).userId,
    req.params.userId,
  );

  res.json({ success: true, message: "Access removed", data: null });
}

export async function createShareLinkController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const role = shareRoleSchema.parse(req.body ?? {}).role;

  const token = await rotateShareToken(
    projectId,
    getAuthContext(req).userId,
    role,
  );

  res.json({
    success: true,
    // Said outright, because "create a new link" quietly breaking the old one
    // would be a nasty surprise.
    message:
      `New ${role === "EDITOR" ? "edit" : "view"} link created. ` +
      "Any link shared earlier no longer works.",
    data: { shareToken: token, shareRole: role },
  });
}

export async function revokeShareLinkController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);

  await revokeShareToken(projectId, getAuthContext(req).userId);

  res.json({
    success: true,
    message: "Link revoked. People already added keep their access.",
    data: null,
  });
}

/** Redeems a share link for the signed-in user. */
export async function redeemShareLinkController(
  req: Request,
  res: Response,
): Promise<void> {
  const token = z.string().min(1).parse((req.body as { token?: unknown })?.token);

  const project = await redeemShareToken(token, getAuthContext(req).userId);

  logger.info("share link redeemed", { projectId: project.id });

  res.json({
    success: true,
    message: `You now have access to "${project.name}"`,
    data: project,
  });
}

/** What a link points at, before the visitor commits to redeeming it.
 *
 *  Deliberately minimal: a name, so someone can tell whether the link is the
 *  one they were expecting, and nothing else about the project or its owner.
 */
export async function previewShareLinkController(
  req: Request,
  res: Response,
): Promise<void> {
  const token = req.query["token"];

  const project =
    typeof token === "string" && token.length > 0
      ? await prisma.project.findFirst({
          // Same clause as `redeemShareToken`. A preview that still named a
          // taken-down project would make this the one endpoint that confirms
          // moderation acted, to anybody holding the link.
          where: { shareToken: token, takenDownAt: null },
          select: { name: true, template: true },
        })
      : null;

  res.json({
    success: true,
    message: project ? "Share link" : "That link is not valid",
    data: project,
  });
}
