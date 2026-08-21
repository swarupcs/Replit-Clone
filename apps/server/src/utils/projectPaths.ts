import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "../config/env.js";
import { BadRequestError, ForbiddenError } from "./errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A projectId is used as BOTH a path segment and a Docker container name, so
 *  it must be validated before it reaches either. */
export function assertValidProjectId(projectId: string): string {
  if (!UUID_RE.test(projectId)) {
    throw new BadRequestError("Invalid project id", "INVALID_PROJECT_ID");
  }
  return projectId;
}

export function projectRoot(projectId: string): string {
  return path.join(PROJECTS_ROOT, assertValidProjectId(projectId));
}

/** Resolves a client-supplied relative path inside a project, or throws.
 *
 *  This is the single choke point that replaces the old contract, where the
 *  client sent an absolute host path that went straight into `fs.*`. Any
 *  WebSocket client could therefore read, overwrite, or recursively delete
 *  anything the server process could reach.
 *
 *  `path.resolve` collapses `..` before we compare, so traversal, absolute
 *  paths, and Windows drive-relative paths all land outside the root and are
 *  rejected. The `root + sep` check prevents a sibling directory whose name
 *  merely starts with the root's name from passing.
 */
export function resolveInProject(projectId: string, relPath: string): string {
  const root = projectRoot(projectId);

  if (typeof relPath !== "string") {
    throw new BadRequestError("Path must be a string");
  }

  // A NUL byte truncates the path inside libuv, so a value like
  // "safe.txt\0../../etc/passwd" could pass a naive prefix check.
  if (relPath.includes("\0")) {
    throw new BadRequestError("Path contains a null byte");
  }

  // Windows separators normalised to POSIX, then any leading slash dropped so
  // an absolute-looking path is treated as project-relative rather than root.
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(root, normalized);

  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new ForbiddenError(
      "Path escapes the project root",
      "PATH_TRAVERSAL",
    );
  }

  return absolute;
}

/** Inverse of resolveInProject: an absolute path back to a POSIX-style path
 *  relative to the project root. Used when building the file tree so host
 *  paths never reach a client. */
export function toRelativePath(projectId: string, absolute: string): string {
  const root = projectRoot(projectId);
  return path.relative(root, absolute).split(path.sep).join("/");
}

/** Group that owns the sandbox home in both images. The home is group-writable,
 *  so any uid paired with this gid has a usable HOME. */
export const SANDBOX_GID = 0;

/** Uid of the `sandbox` user baked into the images; used when the project
 *  directory's real owner cannot be determined. */
export const SANDBOX_UID = 1001;

/** Recursively gives a project's tree to the sandbox uid.
 *
 *  Project directories are created by the SERVER process, and are then
 *  bind-mounted into a container that runs as a different user. A bind mount
 *  keeps the host's ownership — the image's own `chown` is masked by it — so
 *  without this the container could not write the directory it works in, and
 *  `npm install` failed with EACCES.
 *
 *  Only root may hand a file to another uid. When the server is not root the
 *  call fails, which is fine: `containerUser` then runs the container as the
 *  directory's actual owner instead. Either way the pair ends up matching.
 */
export async function claimForSandbox(target: string): Promise<void> {
  // Before the walk, so a server that lacks permission aborts on one syscall
  // rather than after descending a whole node_modules tree.
  await fs.lchown(target, SANDBOX_UID, SANDBOX_GID);

  const entries = await fs.readdir(target, { withFileTypes: true });

  for (const entry of entries) {
    const child = path.join(target, entry.name);
    // `lchown`, not `chown`, so a symlink is retargeted rather than whatever it
    // points at — which may sit outside the project.
    if (entry.isDirectory()) await claimForSandbox(child);
    else await fs.lchown(child, SANDBOX_UID, SANDBOX_GID);
  }
}

/** Gives ONE path to the sandbox uid, without descending anywhere.
 *
 *  For a file that has just been written. `claimForSandbox` walks the whole
 *  tree, so calling it on an upload's destination re-chowned everything under
 *  it — uploading to the project root meant tens of thousands of `lchown`
 *  calls across `node_modules`, on every single upload.
 */
export async function claimOneForSandbox(target: string): Promise<void> {
  await fs.lchown(target, SANDBOX_UID, SANDBOX_GID);
}

/** The `user:group` a project's container must run as.
 *
 *  Matching the bind mount's owner is what makes it writable. Never uid 0: the
 *  whole point of the unprivileged user is that project code is not root, so a
 *  root-owned directory falls back to the image's own uid — `claimForSandbox`
 *  will have succeeded in that case anyway, since only root sees uid 0 here.
 */
export async function containerUser(projectId: string): Promise<string> {
  const stats = await fs.stat(projectRoot(projectId)).catch(() => undefined);
  const uid = stats && stats.uid !== 0 ? stats.uid : SANDBOX_UID;
  return `${String(uid)}:${String(SANDBOX_GID)}`;
}
