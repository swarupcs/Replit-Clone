import type { Request, Response } from "express";
import { z } from "zod";
import archiver from "archiver";
import {
  createProjectService,
  deleteProjectService,
  duplicateProjectService,
  EXCLUDED_GLOBS,
  projectDir,
  renameProjectService,
  assertProjectAccess,
} from "../service/projectService.js";
import { getEnvVars, setEnvVars } from "../service/projectEnvService.js";
import { listAccessibleProjects } from "../service/projectAccessService.js";
import { logger } from "../lib/logger.js";
import { buildFileTree } from "../service/fileTreeService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  listTemplates,
  DEFAULT_TEMPLATE_ID,
  getTemplate,
} from "../templates/registry.js";

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
  // Includes projects shared with this user, not only their own — a project
  // they can open but cannot see in the list would be unreachable.
  const projects = await listAccessibleProjects(getAuthContext(req).userId);

  res.json({ success: true, message: "Projects", data: projects });
}

export async function getProjectTree(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  // Paths in this tree are relative to the project root; the old
  // `directory-tree` output leaked absolute host paths.
  const tree = await buildFileTree(projectId);

  res.json({
    success: true,
    message: "Successfully fetched the tree",
    data: tree,
  });
}

/** Ports this project's preview may be pointed at. */
export async function getProjectPorts(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const project = await assertProjectAccess(
    projectId,
    getAuthContext(req).userId,
    "viewer",
  );
  const template = getTemplate(project.template);

  res.json({
    success: true,
    message: "Preview ports",
    data: {
      devPort: template.devPort,
      ports: [template.devPort, ...(template.extraPorts ?? [])],
    },
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

export function listTemplatesController(
  _req: Request,
  res: Response,
): Promise<void> {
  // `image` and `filesDir` are server-side details; the client only needs
  // enough to render the picker.
  const data = listTemplates().map(
    ({ id, label, devPort, extraPorts, startCommand }) => ({
      id,
      label,
      devPort,
      previewPorts: [devPort, ...(extraPorts ?? [])],
      startCommand,
    }),
  );

  res.json({ success: true, message: "Templates", data });
  return Promise.resolve();
}

const renameSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export async function renameProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const { name } = renameSchema.parse(req.body ?? {});

  const project = await renameProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
    name,
  );

  res.json({ success: true, message: "Project renamed", data: project });
}

const duplicateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

export async function duplicateProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const { name } = duplicateSchema.parse(req.body ?? {});

  const project = await duplicateProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
    name,
  );

  res.status(201).json({ success: true, message: "Project duplicated", data: project });
}

/** Streams the project as a zip.
 *
 *  Streamed rather than buffered: a project can be far larger than is
 *  comfortable to hold in memory, and there is no reason to wait for the whole
 *  archive before the download starts. Dependencies and build output are
 *  excluded — they are reproducible, and they are most of the bytes.
 */
export async function exportProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const project = await assertProjectAccess(
    projectId,
    getAuthContext(req).userId,
    "viewer",
  );

  const filename = `${project.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "project"}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );

  const archive = archiver("zip", { zlib: { level: 6 } });

  // The headers are already sent by the time most failures can happen, so the
  // only honest thing left is to abort the response and say why in the log.
  archive.on("warning", (error: Error) => {
    logger.warn("export warning", { projectId, reason: error.message });
  });
  archive.on("error", (error: Error) => {
    logger.error("export failed", error, { projectId });
    res.destroy();
  });

  archive.pipe(res);
  archive.glob("**/*", {
    cwd: projectDir(projectId),
    dot: true,
    ignore: [...EXCLUDED_GLOBS],
  });

  await archive.finalize();
}

export async function getProjectEnvController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Editor, not viewer: these values are usually secrets, and read-only access
  // to a project is not the same as being trusted with its credentials.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "editor");

  res.json({
    success: true,
    message: "Environment variables",
    data: await getEnvVars(projectId),
  });
}

export async function setProjectEnvController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId);

  const body = req.body as { vars?: unknown } | undefined;
  const saved = await setEnvVars(projectId, body?.vars ?? {});

  res.json({
    success: true,
    // Accurate now: a container records the environment it was built with, so
    // the next start rebuilds it rather than reusing one holding the old set.
    // Restart is the shortest path to that.
    message: "Saved. Restart the dev server to pick them up.",
    data: saved,
  });
}
