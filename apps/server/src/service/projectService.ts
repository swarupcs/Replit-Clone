import fs from "node:fs/promises";
import path from "node:path";
import directoryTree from "directory-tree";
import type { DirectoryTree } from "directory-tree";
import type { Project } from "../generated/prisma/client.js";
import { env, PROJECTS_ROOT } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { execPromisified } from "../utils/execUtility.js";
import { NotFoundError } from "../utils/errors.js";

export { PROJECTS_ROOT };

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId);
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
  });
}

/** Loads a project and asserts the caller owns it.
 *
 *  Every route and socket handler that touches project data must go through
 *  this. Previously an unguessable project id WAS the access control, which
 *  meant a leaked URL granted a shell on the host.
 *
 *  A project owned by someone else reports 404 rather than 403 so the endpoint
 *  cannot be used to probe which project ids exist.
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string,
): Promise<Project> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  if (!project) throw new NotFoundError("Project not found");
  if (project.ownerId !== userId) throw new NotFoundError("Project not found");

  return project;
}

export async function createProjectService(
  ownerId: string,
  name?: string,
): Promise<Project> {
  if (!env.REACT_PROJECT_COMMAND) {
    throw new Error("REACT_PROJECT_COMMAND is not configured");
  }

  const project = await prisma.project.create({
    data: {
      name: name?.trim() || "Untitled project",
      ownerId,
      template: "react-vite",
    },
  });

  const dir = projectDir(project.id);

  try {
    // `recursive` also creates PROJECTS_ROOT, which is gitignored and so absent
    // on a fresh clone.
    await fs.mkdir(dir, { recursive: true });
    await execPromisified(env.REACT_PROJECT_COMMAND, { cwd: dir });
  } catch (error) {
    // Do not leave a DB row pointing at a directory that was never scaffolded.
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

  await prisma.project.delete({ where: { id: projectId } });
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

export async function getProjectTreeService(
  projectId: string,
  userId: string,
): Promise<DirectoryTree | null> {
  await assertProjectAccess(projectId, userId);
  return directoryTree(projectDir(projectId));
}

export async function touchProject(projectId: string): Promise<void> {
  await prisma.project
    .update({ where: { id: projectId }, data: { lastActiveAt: new Date() } })
    .catch(() => {
      // A socket for a deleted project is not worth failing the request over.
    });
}

