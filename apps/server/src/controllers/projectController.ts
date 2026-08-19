import type { Request, Response } from "express";
import { z } from "zod";
import {
  createProjectService,
  deleteProjectService,
  getProjectTreeService,
  listProjects,
} from "../service/projectService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

function requireUserId(req: Request): string {
  return getAuthContext(req).userId;
}

export async function createProjectController(
  req: Request,
  res: Response,
): Promise<void> {
  const userId = requireUserId(req);
  const { name } = createProjectSchema.parse(req.body ?? {});

  const project = await createProjectService(userId, name);

  res.status(201).json({
    success: true,
    message: "Project created",
    data: project,
  });
}

export async function listProjectsController(
  req: Request,
  res: Response,
): Promise<void> {
  const projects = await listProjects(requireUserId(req));

  res.json({ success: true, message: "Projects", data: projects });
}

export async function getProjectTree(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const tree = await getProjectTreeService(
    req.params.projectId,
    requireUserId(req),
  );

  res.json({
    success: true,
    message: "Successfully fetched the tree",
    data: tree,
  });
}

export async function deleteProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  await deleteProjectService(req.params.projectId, requireUserId(req));

  res.json({ success: true, message: "Project deleted", data: null });
}
