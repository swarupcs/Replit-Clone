import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";
import { claimForSandbox, projectRoot } from "../utils/projectPaths.js";
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  TEMPLATE_FILES_ROOT,
} from "../templates/registry.js";
import {
  removeCacheVolume,
  removeContainer,
} from "../containers/containerManager.js";
import { forgetRun } from "../containers/runner.js";
import { forgetUsage } from "./diskUsageService.js";

export function projectDir(projectId: string): string {
  return projectRoot(projectId);
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
  });
}

/** Loads a project and asserts the caller owns it.
 *
 *  Every route and socket handler that touches project data goes through this.
 *  A project owned by someone else reports 404 rather than 403 so the endpoint
 *  cannot be used to probe which project ids exist.
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string,
): Promise<Project> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project || project.ownerId !== userId) {
    throw new NotFoundError("Project not found");
  }

  return project;
}

export async function createProjectService(
  ownerId: string,
  name?: string,
  templateId: string = DEFAULT_TEMPLATE_ID,
): Promise<Project> {
  const template = getTemplate(templateId);

  const project = await prisma.project.create({
    data: {
      name: name?.trim() || template.label,
      ownerId,
      template: template.id,
    },
  });

  const dir = projectDir(project.id);

  try {
    await fs.mkdir(dir, { recursive: true });

    // Copy committed starter files rather than shelling out to `npm create`
    // on the HOST. That call ran an arbitrary configured command outside any
    // sandbox, needed the network, and produced a nested `sandbox/` directory
    // so the bind-mount root and the app root disagreed by one level.
    await fs.cp(path.join(TEMPLATE_FILES_ROOT, template.filesDir), dir, {
      recursive: true,
    });

    // The container runs as the sandbox user, not as the server. Without this
    // the bind mount is read-only to it and `npm install` fails with EACCES.
    // Best-effort: when the server is not root this cannot succeed, and
    // `containerUser` matches the container to the directory instead.
    await claimForSandbox(dir).catch(() => {});
  } catch (error) {
    // Never leave a DB row pointing at a directory that was not scaffolded.
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return project;
}

export async function deleteProjectService(
  projectId: string,
  userId: string,
): Promise<void> {
  await assertProjectAccess(projectId, userId);

  await removeContainer(projectId);
  // The cache volume outlives a restart deliberately, but not the project.
  await removeCacheVolume(projectId);
  // Otherwise a recreated project with the same id would inherit stale run
  // state and a log from the deleted one.
  forgetRun(projectId);
  forgetUsage(projectId);
  await prisma.project.delete({ where: { id: projectId } });
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

export async function touchProject(projectId: string): Promise<void> {
  await prisma.project
    .update({ where: { id: projectId }, data: { lastActiveAt: new Date() } })
    .catch(() => {
      // A socket for a deleted project is not worth failing the request over.
    });
}

/** Renames a project. The directory is keyed by id, so only the row changes. */
export async function renameProjectService(
  projectId: string,
  userId: string,
  name: string,
): Promise<Project> {
  await assertProjectAccess(projectId, userId);

  return prisma.project.update({
    where: { id: projectId },
    data: { name: name.trim() },
  });
}

/** Copies a project's files into a brand new project.
 *
 *  Dependencies are deliberately not copied: `node_modules` is the bulk of a
 *  project's bytes, is reproducible from the manifest, and copying it would
 *  make a duplicate slower than a fresh install. Environment variables come
 *  along, because a copy that cannot run is not much of a copy.
 */
export async function duplicateProjectService(
  projectId: string,
  userId: string,
  name?: string,
): Promise<Project> {
  const source = await assertProjectAccess(projectId, userId);

  const copy = await prisma.project.create({
    data: {
      name: name?.trim() || `${source.name} copy`,
      ownerId: userId,
      template: source.template,
      envVars: source.envVars ?? {},
    },
  });

  const destination = projectDir(copy.id);

  try {
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(projectDir(projectId), destination, {
      recursive: true,
      filter: (entrySource) => !EXCLUDED_FROM_COPY.test(entrySource),
    });
    await claimForSandbox(destination).catch(() => {});
  } catch (error) {
    await prisma.project.delete({ where: { id: copy.id } }).catch(() => {});
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return copy;
}

/** Directories a copy or an export has no business carrying. */
const EXCLUDED_FROM_COPY =
  /(^|[\\/])(node_modules|\.git|dist|build|\.next|__pycache__|\.venv)([\\/]|$)/;

export { EXCLUDED_FROM_COPY };
