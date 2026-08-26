import fs from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRECTORIES } from "./fileTreeService.js";
import { projectRoot } from "../utils/projectPaths.js";

const IGNORED = new Set<string>(IGNORED_DIRECTORIES);

/** Extensions the TypeScript language service can actually do anything with.
 *
 *  Everything else — images, CSS, lockfiles — would cost bytes to ship and
 *  memory to hold while teaching the worker nothing about where a symbol is
 *  defined. */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
]);

/** Caps. These exist because the whole result is held in the server's memory,
 *  sent over one socket frame, and then held again in the browser as Monaco
 *  models. A project big enough to blow through them is one where whole-project
 *  navigation was never going to be cheap. */
const MAX_FILES = 400;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 12;

export interface ProjectSource {
  relPath: string;
  contents: string;
}

export interface ProjectSources {
  files: ProjectSource[];
  /** True when a cap stopped the walk, so the client can say that navigation
   *  covers part of the project rather than pretending it is complete. */
  truncated: boolean;
}

/** Every source file in a project, for Monaco's TypeScript worker.
 *
 *  The editor creates a model only for a file whose tab is open, so its worker
 *  only ever knew about files the user had already found — which made
 *  go-to-definition useless for exactly the case it exists to serve. This is
 *  the bulk read that fixes that.
 *
 *  Read once when the project opens rather than kept in sync: a definition
 *  lookup that is a few edits stale still lands in the right file, and the
 *  alternative is streaming every keystroke of every file to every client.
 */
export async function readProjectSources(
  projectId: string,
): Promise<ProjectSources> {
  const root = projectRoot(projectId);
  const files: ProjectSource[] = [];

  let totalBytes = 0;
  let truncated = false;

  async function walk(absolute: string, relPath: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || truncated) return;

    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (truncated) return;
      if (IGNORED.has(entry.name)) continue;

      const childAbsolute = path.join(absolute, entry.name);
      // POSIX separators: the client uses these as model URIs, and a Windows
      // host would otherwise produce paths no import specifier could match.
      const childRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelPath, depth + 1);
        continue;
      }

      // A symlink is neither followed nor read: it could point anywhere on the
      // host, and resolving it is exactly what projectPaths exists to prevent.
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) continue;

      const stats = await fs.stat(childAbsolute).catch(() => null);
      if (!stats || stats.size > MAX_FILE_BYTES) continue;

      if (files.length >= MAX_FILES || totalBytes + stats.size > MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }

      const contents = await fs.readFile(childAbsolute, "utf8").catch(() => null);
      if (contents === null) continue;

      totalBytes += stats.size;
      files.push({ relPath: childRelPath, contents });
    }
  }

  await walk(root, "", 0);

  return { files, truncated };
}
