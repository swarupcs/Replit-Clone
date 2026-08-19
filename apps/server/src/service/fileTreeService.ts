import fs from "node:fs/promises";
import path from "node:path";
import type { TreeNodeData } from "@replit-clone/shared";
import { projectRoot } from "../utils/projectPaths.js";

/** Directories never worth sending to the client — huge, and the editor has no
 *  business browsing them. */
const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
]);

/** Guards against a symlink loop or a pathological tree pinning the process. */
const MAX_DEPTH = 12;
const MAX_ENTRIES = 5000;

/** Builds a project's file tree with POSIX paths RELATIVE to the project root.
 *
 *  Replaces `directory-tree`, which emitted absolute host paths — those leaked
 *  the server's filesystem layout and were what the client echoed back as the
 *  target of every file operation.
 */
export async function buildFileTree(projectId: string): Promise<TreeNodeData> {
  const root = projectRoot(projectId);
  let budget = MAX_ENTRIES;

  async function walk(
    absolute: string,
    relPath: string,
    depth: number,
  ): Promise<TreeNodeData> {
    const name = relPath === "" ? path.basename(absolute) : path.basename(relPath);

    if (depth > MAX_DEPTH || budget <= 0) {
      return { name, relPath, type: "directory", children: [] };
    }

    // `withFileTypes` avoids a stat per entry; `lstat` semantics mean a symlink
    // reports as a symlink rather than its target, so links out of the project
    // are listed but never descended into.
    const entries = await fs.readdir(absolute, { withFileTypes: true });

    const children: TreeNodeData[] = [];

    for (const entry of entries.sort(compareEntries)) {
      if (budget-- <= 0) break;
      if (IGNORED.has(entry.name)) continue;

      const childRelPath = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
      const childAbsolute = path.join(absolute, entry.name);

      if (entry.isDirectory()) {
        children.push(await walk(childAbsolute, childRelPath, depth + 1));
      } else if (entry.isFile()) {
        const stats = await fs.stat(childAbsolute).catch(() => null);
        children.push({
          name: entry.name,
          relPath: childRelPath,
          type: "file",
          size: stats?.size ?? 0,
        });
      }
    }

    return { name, relPath, type: "directory", children };
  }

  return walk(root, "", 0);
}

/** Directories first, then case-insensitive by name — the ordering every file
 *  explorer uses. */
function compareEntries(
  a: { name: string; isDirectory(): boolean },
  b: { name: string; isDirectory(): boolean },
): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
