import type { Request, Response } from "express";
import { z } from "zod";
import archiver from "archiver";
import {
  createProjectService,
  deleteProjectService,
  duplicateProjectService,
  forkProjectService,
  EXCLUDED_GLOBS,
  projectDir,
  renameProjectService,
  assertProjectAccess,
} from "../service/projectService.js";
import {
  envVarsEncryptedAtRest,
  getEnvVars,
  setEnvVars,
} from "../service/projectEnvService.js";
import {
  listAccessibleProjects,
  listPublicProjects,
  setProjectVisibility,
  ProjectVisibility,
} from "../service/projectAccessService.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
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
  //
  // Paged, and the dashboard asks for every page: it searches and sorts the
  // whole set in the browser, so a page break would mean a project that
  // exists reading as one that does not. The page is a bound on the query,
  // not on what the screen is allowed to show.
  const page = await listAccessibleProjects(getAuthContext(req).userId, req.query);

  res.json({ success: true, message: "Projects", data: page });
}

export async function getProjectTree(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Visitor: reading the files IS what a public project offers. Everything
  // else about the project stays at viewer or above.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "visitor");

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

const forkSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

/** Takes a copy of a public project.
 *
 *  Separate from duplicate rather than a flag on it, because the two differ in
 *  the two things that matter: the access level required, and whether the
 *  environment variables come along. A flag would put both decisions in one
 *  branch, which is where a mistake would be least visible.
 */
export async function forkProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const { name } = forkSchema.parse(req.body ?? {});

  const project = await forkProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
    name,
  );

  res.status(201).json({ success: true, message: "Project forked", data: project });
}

const visibilitySchema = z.object({
  visibility: z.enum(["private", "public"]),
});

/** Publishes a project's source, or takes it back. */
export async function setVisibilityController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const { visibility } = visibilitySchema.parse(req.body ?? {});

  const project = await setProjectVisibility(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
    visibility === "public" ? ProjectVisibility.PUBLIC : ProjectVisibility.PRIVATE,
  );

  res.json({
    success: true,
    message: visibility === "public" ? "Project is public" : "Project is private",
    data: project,
  });
}

/** The gallery. Anybody signed in may read it; it names no project that is not
 *  already public. */
export async function listPublicProjectsController(
  req: Request,
  res: Response,
): Promise<void> {
  res.json({
    success: true,
    message: "Public projects",
    data: await listPublicProjects(req.query),
  });
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
  // Visitor: a zip is a bulk read of files this caller may already read one at
  // a time, so refusing it would protect nothing. The same exclusions apply --
  // no .git, so no remote URL and no history.
  const project = await assertProjectAccess(
    projectId,
    getAuthContext(req).userId,
    "visitor",
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
    // `encryptedAtRest` travels with the values rather than sitting on a
    // status endpoint, because the only moment it changes what anybody does is
    // the moment they are looking at the dialog deciding whether to paste a
    // live key into it.
    data: {
      vars: await getEnvVars(projectId),
      encryptedAtRest: envVarsEncryptedAtRest(),
    },
  });
}

export async function setProjectEnvController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Named rather than taken from the default, which this was the only caller
  // in the codebase to rely on. Editor is the right answer -- an editor can
  // already run arbitrary code in this container, so setting a variable it
  // will read grants them nothing they did not have -- but it is the answer
  // this endpoint should get by somebody choosing it, since the next person
  // to change that default will be reasoning about the other ninety routes.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "editor");

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

/** What `Run` executes for this project, and the template's default beside it.
 *
 *  Both, because "npm run dev" alone does not tell you whether it is the
 *  project's own choice or the template's — and knowing which is what tells you
 *  whether clearing the field will help.
 */
export async function getStartCommandController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Visitor: how a project is run is part of reading it, and the editor asks
  // for this on open. It names a command, never a credential.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "visitor");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { template: true, startCommand: true },
  });

  res.json({
    success: true,
    message: "Start command",
    data: {
      command: project?.startCommand ?? null,
      templateDefault: getTemplate(project?.template ?? "react-vite").startCommand,
    },
  });
}

const startCommandSchema = z.object({
  /** Empty means "go back to the template's", which is the only way to undo a
   *  bad edit without knowing what the default was. */
  command: z.string().max(2000),
});

export async function setStartCommandController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Editor: it decides what runs inside the container, which is the same
  // authority as writing the files that run.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "editor");

  const { command } = startCommandSchema.parse(req.body ?? {});
  const trimmed = command.trim();

  const project = await prisma.project.update({
    where: { id: projectId },
    data: { startCommand: trimmed || null },
    select: { template: true, startCommand: true },
  });

  res.json({
    success: true,
    message: "Saved. Restart the dev server to use it.",
    data: {
      command: project.startCommand,
      templateDefault: getTemplate(project.template).startCommand,
    },
  });
}
