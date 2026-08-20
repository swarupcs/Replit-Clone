import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { MAX_FILE_BYTES } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectService.js";
import {
  assertWithinQuota,
  recordWrite,
} from "../service/diskUsageService.js";
import { claimForSandbox } from "../utils/projectPaths.js";
import { assertValidProjectId, resolveInProject } from "../utils/projectPaths.js";
import { BadRequestError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";

/** Getting files in and out of a project.
 *
 *  There was no way to do either: an image could not be added to a project and
 *  a build artifact could not be taken out, short of pasting text through the
 *  editor. Uploads are bounded and quota-checked exactly like an editor write,
 *  because they are the same thing arriving by a different route.
 */

/** Largest single upload. Matches the editor's own ceiling for text; binary
 *  assets are usually well under it and a project has a storage quota besides. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Files whose name would make them a trap rather than an asset. */
function assertSafeName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));

  if (!base || base === "." || base === "..") {
    throw new BadRequestError("That file has no usable name");
  }
  if (base.includes("\0")) {
    throw new BadRequestError("File name contains a null byte");
  }

  return base;
}

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export async function uploadFilesController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "editor");

  const files = (req as unknown as { files?: UploadedFile[] }).files ?? [];
  if (files.length === 0) throw new BadRequestError("No files were uploaded");

  // The destination folder, relative to the project root. Resolved through the
  // same choke point as every other path the client names.
  const body = req.body as { destDir?: unknown } | undefined;
  const destDir = typeof body?.destDir === "string" ? body.destDir : "";
  const destAbsolute = resolveInProject(projectId, destDir);

  const written: string[] = [];

  for (const file of files) {
    const name = assertSafeName(file.originalname);
    const relPath = destDir ? `${destDir}/${name}` : name;
    const absolute = resolveInProject(projectId, relPath);

    const existing = await fs.stat(absolute).catch(() => undefined);
    await assertWithinQuota(projectId, file.size, existing?.size ?? 0);

    await fs.mkdir(destAbsolute, { recursive: true });
    await fs.writeFile(absolute, file.buffer);
    recordWrite(projectId, file.size, existing?.size ?? 0);

    written.push(relPath);
  }

  // New files belong to the container's user like everything else in the tree,
  // or the project could not modify what it was just given.
  await claimForSandbox(destAbsolute).catch(() => {});

  logger.info("files uploaded", { projectId, count: written.length });

  res.status(201).json({
    success: true,
    message: `Uploaded ${String(written.length)} file${written.length === 1 ? "" : "s"}`,
    data: { paths: written },
  });
}

/** Streams one file back as a download. */
export async function downloadFileController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const relPath = req.query["path"];
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new BadRequestError("A path is required");
  }

  const absolute = resolveInProject(projectId, relPath);
  const stats = await fs.stat(absolute).catch(() => undefined);

  if (!stats?.isFile()) throw new BadRequestError("That is not a file");

  // `attachment` rather than inline: the file is the user's own content served
  // from the API's origin, and rendering it there is exactly the same problem
  // the preview sandbox exists to avoid.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${path.posix.basename(relPath).replace(/["\\]/g, "")}"`,
  );
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(stats.size));
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.sendFile(absolute);
}

export { MAX_FILE_BYTES };
