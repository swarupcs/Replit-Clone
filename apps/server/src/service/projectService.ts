import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { assertProjectAccess as assertAccess } from "./projectAccessService.js";
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
import { forgetProject as forgetCollab } from "./collabService.js";
import { assertCanCreateProject } from "./userQuotaService.js";

export function projectDir(projectId: string): string {
  return projectRoot(projectId);
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
  });
}

/** Re-exported so every existing caller keeps working while the check itself
 *  became role-aware. See projectAccessService for what the levels mean. */
export { assertProjectAccess } from "./projectAccessService.js";

export async function createProjectService(
  ownerId: string,
  name?: string,
  templateId: string = DEFAULT_TEMPLATE_ID,
): Promise<Project> {
  const template = getTemplate(templateId);

  // Before the row is written, so a refusal leaves nothing behind.
  await assertCanCreateProject(ownerId);

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
  // Owner only: a collaborator losing the project for everyone is not a
  // mistake worth making recoverable, because it is not recoverable.
  await assertAccess(projectId, userId, "owner");

  await removeContainer(projectId);
  // The cache volume outlives a restart deliberately, but not the project.
  await removeCacheVolume(projectId);
  // Otherwise a recreated project with the same id would inherit stale run
  // state and a log from the deleted one.
  forgetRun(projectId);
  forgetUsage(projectId);
  forgetCollab(projectId);
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
  await assertAccess(projectId, userId, "owner");

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
  // A viewer may take a copy — the copy is theirs, and they could have done it
  // by hand from the file tree anyway. It still counts against their own quota.
  const source = await assertAccess(projectId, userId, "viewer");
  await assertCanCreateProject(userId);

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

/** Directories a copy or an export has no business carrying.
 *
 *  Dependencies and build output are reproducible from the manifest and are
 *  most of a project's bytes, so carrying them would make a duplicate slower
 *  than a fresh install and an export far larger than it needs to be.
 */
export const EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
] as const;

/** For `fs.cp`, which filters absolute paths. */
const EXCLUDED_FROM_COPY = new RegExp(
  `(^|[\\\\/])(${EXCLUDED_DIRECTORIES.map((name) =>
    name.replace(/\./g, "\\."),
  ).join("|")})([\\\\/]|$)`,
);

/** For archiver's glob, which takes patterns. Derived from the same list so
 *  the two cannot drift apart. */
export const EXCLUDED_GLOBS = EXCLUDED_DIRECTORIES.map(
  (name) => `**/${name}/**`,
);
