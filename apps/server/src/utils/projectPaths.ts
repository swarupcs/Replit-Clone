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
