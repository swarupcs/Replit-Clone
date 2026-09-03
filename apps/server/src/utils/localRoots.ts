import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL_FOLDER_ROOTS, PROJECTS_ROOT } from "../config/env.js";
import { BadRequestError, ForbiddenError } from "./errors.js";

/** What may be opened as a folder, and what may not.
 *
 *  `resolveInProject` is the choke point for a path INSIDE a project; this is
 *  the choke point for the project root itself, and it is the more dangerous of
 *  the two. A root that gets through here is bind-mounted into a container that
 *  runs arbitrary code as a user who can write it, and its contents are handed
 *  to anybody who can read the project. `/`, the deployment's own checkout and
 *  its `.env` are all directories, and none of them may be openable.
 *
 *  The rule is the same shape as every other allowlist in this codebase --
 *  `DEVCONTAINER_IMAGE_ALLOWLIST`, `EGRESS_ALLOW_DOMAINS` -- with one
 *  difference that matters: an empty list here means REFUSE EVERYTHING rather
 *  than allow everything. An operator who has not thought about this has not
 *  opted into it, and the safe reading of silence is off.
 */

/** Whether this deployment allows folders to be opened at all. */
export function localFoldersEnabled(): boolean {
  return LOCAL_FOLDER_ROOTS.length > 0;
}

/** The roots as configured, for the screen that offers them. */
export function localFolderRoots(): string[] {
  return [...LOCAL_FOLDER_ROOTS];
}

/** True when `candidate` is `root` or sits beneath it.
 *
 *  The `root + sep` clause is `resolveInProject`'s, for its reason: without it
 *  `/home/user-backup` passes a prefix test against `/home/user`.
 */
function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Resolves a client-supplied host path to a folder that may be opened, or
 *  throws.
 *
 *  Three checks, and the order is deliberate:
 *
 *  1. **Shape**, before touching the filesystem: absolute, no NUL byte. A NUL
 *     truncates the path inside libuv, so `"/allowed\0/../../etc"` would pass a
 *     naive comparison and then open something else.
 *
 *  2. **Reality, then confinement.** `realpath` first and the allowlist check
 *     against its RESULT, because the interesting attack is a symlink: a link
 *     at `/allowed/escape` pointing at `/` is inside the root by name and is
 *     the whole filesystem by content. Comparing the resolved path is what
 *     makes the allowlist mean the directory rather than the name.
 *
 *  3. **Not a server-owned tree.** PROJECTS_ROOT is refused even when an
 *     operator has named a root that contains it. Two rows over one directory
 *     with different rules about who may delete it is not a state anything
 *     downstream is built to arbitrate, and the row that thinks it owns the
 *     tree would win.
 */
export async function resolveLocalFolder(candidate: string): Promise<string> {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new BadRequestError("A folder path is required", "PATH_REQUIRED");
  }

  if (candidate.includes("\0")) {
    throw new BadRequestError("Path contains a null byte");
  }

  if (!localFoldersEnabled()) {
    throw new ForbiddenError(
      "This deployment does not allow opening folders from disk. " +
        "Set LOCAL_FOLDER_ROOTS to the directories it may open.",
      "LOCAL_FOLDERS_DISABLED",
    );
  }

  if (!path.isAbsolute(candidate)) {
    throw new BadRequestError(
      "A folder path must be absolute",
      "PATH_NOT_ABSOLUTE",
    );
  }

  // Through symlinks, so what is checked below is the directory this actually
  // reaches rather than the name it was reached by.
  let resolved: string;
  try {
    resolved = await fs.realpath(path.resolve(candidate));
  } catch {
    throw new BadRequestError("No such folder", "FOLDER_NOT_FOUND");
  }

  const stats = await fs.stat(resolved).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new BadRequestError("Not a folder", "NOT_A_DIRECTORY");
  }

  if (!LOCAL_FOLDER_ROOTS.some((root) => within(resolved, root))) {
    throw new ForbiddenError(
      "That folder is outside the directories this deployment may open",
      "PATH_NOT_ALLOWED",
    );
  }

  if (within(resolved, PROJECTS_ROOT)) {
    throw new ForbiddenError(
      "That folder is a project this server already owns",
      "PATH_IS_SERVER_OWNED",
    );
  }

  return resolved;
}

/** One level of subdirectories under an allowed folder, for choosing one.
 *
 *  A path field alone would be a poor way in -- you would have to already know
 *  what you are looking for, and every typo is a refusal -- so the screen
 *  walks. It walks through `resolveLocalFolder`, which is what keeps this from
 *  being a directory-listing endpoint over the whole host.
 *
 *  Directories only, and dotfiles dropped: neither `.git` nor `.cache` is
 *  somewhere anybody means to open, and listing them is noise in front of the
 *  three folders that are.
 */
export async function listLocalFolders(
  parent: string,
): Promise<{ path: string; name: string }[]> {
  const resolved = await resolveLocalFolder(parent);

  const entries = await fs
    .readdir(resolved, { withFileTypes: true })
    .catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      path: path.join(resolved, entry.name),
      name: entry.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
