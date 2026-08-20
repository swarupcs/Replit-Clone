import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";
import { projectRoot } from "../utils/projectPaths.js";
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  TEMPLATE_FILES_ROOT,
} from "../templates/registry.js";
import { removeContainer } from "../containers/containerManager.js";
import { forgetRun } from "../containers/runner.js";

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
  // Otherwise a recreated project with the same id would inherit stale run
  // state and a log from the deleted one.
  forgetRun(projectId);
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
