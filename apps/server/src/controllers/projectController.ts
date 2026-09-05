import type { Request, Response } from "express";
import { z } from "zod";
import archiver from "archiver";
import {
  createProjectService,
  trashProjectService,
  restoreProjectService,
  purgeProjectService,
  listTrashedProjects,
  TRASH_DAYS,
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
import {
  previewablePorts,
  publishedPorts,
  runningProjectContainers,
} from "../containers/containerManager.js";
import { env } from "../config/env.js";
import {
  budgetMb,
  committedMb,
  MIN_MEMORY_MB,
  resolveSize,
  setWorkspaceSize,
} from "../service/workspaceSizeService.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { buildFileTree } from "../service/fileTreeService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { retryScaffold, templatesWithRecipes } from "../service/scaffoldService.js";
import {
  listTemplates,
  DEFAULT_TEMPLATE_ID,
  getTemplate,
} from "../templates/registry.js";

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  template: z.string().trim().min(1).max(50).optional(),
  /** Defaults to the starter, so every existing caller keeps its behaviour and
   *  the slower, network-dependent path is one somebody has to ask for. */
  variant: z.enum(["starter", "latest"]).default("starter"),
});

export async function createProjectController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { name, template, variant } = createProjectSchema.parse(req.body ?? {});

  const project = await createProjectService(
    userId,
    name,
    template ?? DEFAULT_TEMPLATE_ID,
    variant,
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

  // `previewablePorts` rather than the template alone: it is the same list the
  // preview's own allowed-check uses, and it honours a devcontainer's
  // `forwardPorts`. Building it here from the template was how a forwarded port
  // could be published by the container and still never reach this dropdown.
  const [ports, hostPorts] = await Promise.all([
    previewablePorts(projectId, template),
    publishedPorts(projectId),
  ]);

  res.json({
    success: true,
    message: "Preview ports",
    data: {
      devPort: template.devPort,
      ports,
      // Only the ports actually offered. The container may publish others, and
      // an address for something the preview will refuse is an invitation to a
      // dead end.
      hostPorts: Object.fromEntries(
        ports
          .filter((port) => hostPorts[port])
          .map((port) => [port, hostPorts[port]]),
      ),
    },
  });
}

/** Delete, which now means "put in the trash".
 *
 *  Same verb, same route, same button: the recoverable path replaces the
 *  irreversible one rather than sitting beside it, because an option nobody
 *  picks protects nobody. The real delete is `purgeProjectController` below,
 *  reachable only from the trash.
 */
export async function deleteProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  await trashProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
  );

  res.json({
    success: true,
    message: `Moved to the trash. It will be deleted in ${String(TRASH_DAYS)} days.`,
    data: { trashDays: TRASH_DAYS },
  });
}

export async function listTrashController(
  req: Request,
  res: Response,
): Promise<void> {
  const projects = await listTrashedProjects(getAuthContext(req).userId);

  res.json({
    success: true,
    message: "Trash",
    data: {
      trashDays: TRASH_DAYS,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        template: project.template,
        // Never null for a row this query returned, and narrowed here rather
        // than asserted so the response type says what the screen can rely on.
        deletedAt: (project.deletedAt ?? new Date()).toISOString(),
        // What "delete for good" will actually do. A purge does not touch a
        // tree this server did not create, so the confirmation for one of
        // these has to say something different -- and it cannot say it without
        // being told which rows they are.
        localPath: project.localPath,
      })),
    },
  });
}

export async function restoreProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const project = await restoreProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
  );

  res.json({ success: true, message: "Project restored", data: project });
}

/** Emptying the trash, for an owner who does not want to wait a week.
 *
 *  Only reachable for a project already in the trash, which is what keeps the
 *  irreversible path from being one button again.
 */
export async function purgeProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  await purgeProjectService(
    assertValidProjectId(req.params.projectId),
    getAuthContext(req).userId,
  );

  res.json({ success: true, message: "Project deleted", data: null });
}

export async function listTemplatesController(
  _req: Request,
  res: Response,
): Promise<void> {
  // Asked of the database rather than hard-coded in the client, so turning a
  // recipe off -- because upstream changed a flag and it now fails -- also
  // removes the option that would fail, without a deploy of the web app.
  const withRecipes = await templatesWithRecipes().catch(
    () => new Set<string>(),
  );

  // `image` and `filesDir` are server-side details; the client only needs
  // enough to render the picker.
  const data = listTemplates().map(
    ({ id, label, devPort, extraPorts, startCommand }) => ({
      id,
      label,
      devPort,
      previewPorts: [devPort, ...(extraPorts ?? [])],
      startCommand,
      latestAvailable: withRecipes.has(id),
    }),
  );

  res.json({ success: true, message: "Templates", data });
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

/** What this workspace is sized at, and what the host could give it.
 *
 *  plan.md §12.1. Both halves in one response deliberately: a number on its own
 *  ("2048 MB") is not something anybody can act on, and the question somebody
 *  opens this to answer is "can I give it more", which needs the budget and
 *  what is already committed against it.
 */
export async function getWorkspaceSizeController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const running = await runningProjectContainers();
  const [size, budget, committed] = await Promise.all([
    resolveSize(projectId),
    budgetMb(),
    committedMb(running.filter((id) => id !== projectId)),
  ]);

  res.json({
    success: true,
    message: "Workspace size",
    data: {
      ...size,
      defaultMemoryMb: env.CONTAINER_MEMORY_MB,
      defaultCpus: env.CONTAINER_CPUS,
      budgetMb: budget,
      committedMb: committed,
      minMemoryMb: MIN_MEMORY_MB,
    },
  });
}

const workspaceSizeSchema = z.object({
  /** Null means "back to the deployment's default", which is the only way to
   *  undo a size without knowing what the default was -- the same argument the
   *  start command's empty string makes above. */
  memoryMb: z.number().int().nullable().optional(),
  cpus: z.number().nullable().optional(),
});

export async function setWorkspaceSizeController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Owner, and not editor. A collaborator with write access decides what runs
  // in the container; how much of the host it is allowed to hold is a decision
  // about somebody else's machine, and every other project on it.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "owner");

  const request = workspaceSizeSchema.parse(req.body ?? {});
  const size = await setWorkspaceSize(
    projectId,
    request,
    await runningProjectContainers(),
  );

  res.json({
    // Not "applied": Docker can change a running container's cgroup, but the
    // process inside it has already read /proc/meminfo and sized its heap. A
    // Node process told it had 512 MB does not start using 8 GB because the
    // limit moved underneath it.
    success: true,
    message: "Saved. It takes effect the next time this workspace starts.",
    data: size,
  });
}

/** Whether this project's files are there yet, and why not.
 *
 *  Polled by the dashboard while a scaffold runs. Viewer, not owner: a
 *  collaborator looking at a project that is still being built should be told
 *  that rather than shown an empty tree.
 */
export async function getScaffoldStatusController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { scaffoldStatus: true, scaffoldLog: true },
  });

  res.json({
    success: true,
    message: "Scaffold",
    data: {
      status: project?.scaffoldStatus ?? "READY",
      // The scaffolder's own words when it failed, and null otherwise. It is
      // the only thing that knows why -- "creation failed" is not something
      // anybody can act on.
      log: project?.scaffoldLog ?? null,
    },
  });
}

export async function retryScaffoldController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  // Owner: this empties the working tree before it starts again, which is not
  // a collaborator's call to make.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "owner");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { template: true, scaffoldStatus: true },
  });

  if (!project) throw new NotFoundError("No such project.");

  // Only from FAILED. Retrying one that is READY would delete a project that
  // works, and retrying one already SCAFFOLDING would run two scaffolders over
  // the same directory.
  if (project.scaffoldStatus !== "FAILED") {
    throw new BadRequestError(
      "This project is not waiting to be rebuilt.",
      "NOT_FAILED",
    );
  }

  const started = await retryScaffold(projectId, project.template);
  if (!started) {
    throw new BadRequestError(
      "This template has no recipe to build from.",
      "NO_RECIPE",
    );
  }

  res.json({ success: true, message: "Building again", data: null });
}
