import type { Request, Response } from "express";
import { z } from "zod";
import {
  createProjectService,
  deleteProjectService,
  listProjects,
  assertProjectAccess,
} from "../service/projectService.js";
import { buildFileTree } from "../service/fileTreeService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { listTemplates, DEFAULT_TEMPLATE_ID } from "../templates/registry.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  template: z.string().trim().min(1).max(50).optional(),
});

export async function createProjectController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { name, template } = createProjectSchema.parse(req.body ?? {});

  const project = await createProjectService(
    userId,
    name,
    template ?? DEFAULT_TEMPLATE_ID,
  );

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
  const projects = await listProjects(getAuthContext(req).userId);

  res.json({ success: true, message: "Projects", data: projects });
}

export async function getProjectTree(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId);

  // Paths in this tree are relative to the project root; the old
  // `directory-tree` output leaked absolute host paths.
  const tree = await buildFileTree(projectId);

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
  await deleteProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
  );

  res.json({ success: true, message: "Project deleted", data: null });
}

export async function listTemplatesController(
  _req: Request,
  res: Response,
): Promise<void> {
  // `image` and `filesDir` are server-side details; the client only needs
  // enough to render the picker.
  const data = listTemplates().map(({ id, label, devPort, startCommand }) => ({
    id,
    label,
    devPort,
    startCommand,
  }));

  res.json({ success: true, message: "Templates", data });
}
