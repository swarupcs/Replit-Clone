import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import directoryTree from "directory-tree";
import type { DirectoryTree } from "directory-tree";
import { REACT_PROJECT_COMMAND } from "../config/serverConfig.js";
import { execPromisified } from "../utils/execUtility.js";

/** Root directory holding every project's working tree. Resolved once, from
 *  process.cwd() at startup, so later `process.chdir` calls cannot move it. */
export const PROJECTS_ROOT: string = path.resolve(process.cwd(), "projects");

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId);
}

export const createProjectService = async (): Promise<string> => {
  if (!REACT_PROJECT_COMMAND) {
    throw new Error("REACT_PROJECT_COMMAND is not configured");
  }

  const projectId = randomUUID();
  const dir = projectDir(projectId);

  // `recursive` also creates PROJECTS_ROOT itself, which is gitignored and so
  // absent on a fresh clone.
  await fs.mkdir(dir, { recursive: true });

  await execPromisified(REACT_PROJECT_COMMAND, { cwd: dir });

  return projectId;
};

export const getProjectTreeService = async (
  projectId: string,
): Promise<DirectoryTree | null> => {
  return directoryTree(projectDir(projectId));
};
