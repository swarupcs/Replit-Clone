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

/** Roots for projects whose tree this server did not create.
 *
 *  `projectRoot` is called from twenty-odd places and is synchronous, and it is
 *  synchronous for a good reason: it sits under `resolveInProject`, which is
 *  the path-confinement check on every file read and write. Making it async to
 *  consult the database would put an await inside the guard and rewrite every
 *  caller, for a lookup whose answer never changes while a project exists.
 *
 *  So the mapping is held here, seeded from the database at boot by
 *  `loadLocalRoots` and maintained by the two operations that change it. A
 *  miss means the ordinary arrangement -- `PROJECTS_ROOT/<id>` -- which is
 *  every project made from a template or imported from GitHub, so an empty map
 *  is exactly the behaviour this had before local folders existed.
 *
 *  The failure mode worth naming: a root registered late reads as server-owned
 *  until it is registered. That is why `loadLocalRoots` runs at boot BEFORE
 *  anything can resolve a path, and why the row and the registration happen
 *  together in `openLocalFolderService` rather than the row being written and
 *  the registry catching up.
 */
const localRoots = new Map<string, string>();

/** Points a project at a tree this server does not own. */
export function registerLocalRoot(projectId: string, root: string): void {
  localRoots.set(assertValidProjectId(projectId), root);
}

/** Forgets one, e.g. once the project is gone. */
export function forgetLocalRoot(projectId: string): void {
  localRoots.delete(projectId);
}

/** Only for tests, which need a clean slate between cases. */
export function resetLocalRoots(): void {
  localRoots.clear();
}

/** Whether this project's tree belongs to somebody other than this server.
 *
 *  The question four call sites have to ask before doing something that is
 *  only defensible on a tree this platform created: deleting it recursively,
 *  chowning it to the sandbox uid, counting it against a disk quota, and
 *  copying out of it as though the copy were equivalent.
 */
export function isLocalProject(projectId: string): boolean {
  return localRoots.has(projectId);
}

/** Seeds the registry from the database. Called once, at boot, before the
 *  server accepts anything -- see the note above about a late registration. */
export async function loadLocalRoots(
  rows: { id: string; localPath: string | null }[],
): Promise<void> {
  localRoots.clear();
  for (const row of rows) {
    if (row.localPath) localRoots.set(row.id, row.localPath);
  }
  await Promise.resolve();
}

/** Where a project's files are.
 *
 *  A folder somebody opened, or the directory this server made for it. Every
 *  path in the product is resolved against whichever this returns, which is
 *  what makes confinement work identically for both: `resolveInProject`
 *  compares against this root and does not care where it came from.
 */
export function projectRoot(projectId: string): string {
  const id = assertValidProjectId(projectId);
  return localRoots.get(id) ?? path.join(PROJECTS_ROOT, id);
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

/** Claims a project's tree for the sandbox uid — unless the tree is not ours.
 *
 *  The guard lives HERE rather than at each call site, which is the same
 *  argument §6 decision 13 makes about a query versus a cleanup: a rule that
 *  every caller has to remember is a rule that usually holds. Two callers
 *  needed it when local folders arrived; the third to be written would not have
 *  known to ask, and the cost of forgetting is somebody's own source directory
 *  handed to uid 1001.
 *
 *  A local folder needs no claim anyway. `containerUser` runs the container as
 *  the directory's real owner, so the mount is already writable — and it is
 *  writable without touching a single file.
 *
 *  The stat is an optimisation with a purpose: it keeps the recursive walk off
 *  every container start, and it is why this is one function rather than a
 *  boolean each caller applies to its own copy of the logic.
 */
export async function claimProjectForSandbox(projectId: string): Promise<void> {
  if (isLocalProject(projectId)) return;

  const root = projectRoot(projectId);
  const stats = await fs.stat(root).catch(() => undefined);

  // Projects scaffolded before ownership was claimed still belong to whoever
  // the server ran as then; one that already matches needs no walk.
  if (!stats || stats.uid === SANDBOX_UID) return;

  // Best-effort: a non-root server cannot hand a tree to another uid, and
  // `containerUser` adapts instead.
  await claimForSandbox(root).catch(() => {});
}

/** The same question for one file that has just been written into a project. */
export async function claimOneForProject(
  projectId: string,
  target: string,
): Promise<void> {
  if (isLocalProject(projectId)) return;
  await claimOneForSandbox(target);
}

/** The `user:group` a project's container must run as.
 *
 *  Matching the bind mount's owner is what makes it writable. Never uid 0: the
 *  whole point of the unprivileged user is that project code is not root, so a
 *  root-owned directory falls back to the image's own uid — `claimForSandbox`
 *  will have succeeded in that case anyway, since only root sees uid 0 here.
 */
export async function containerUser(projectId: string): Promise<string> {
  return userForDirectory(projectRoot(projectId));
}

/** The same question for a directory that is not a project working tree.
 *
 *  A deployment's container bind-mounts a COPY of the tree rather than the
 *  tree itself, so it needs the rule without the project id in front of it.
 */
export async function userForDirectory(directory: string): Promise<string> {
  const stats = await fs.stat(directory).catch(() => undefined);
  const uid = stats && stats.uid !== 0 ? stats.uid : SANDBOX_UID;
  return `${String(uid)}:${String(SANDBOX_GID)}`;
}
