import type { Request, Response } from "express";
import { z } from "zod";
import {
  browseLocalFolders,
  localFolderSettings,
  openLocalFolderService,
} from "../service/localFolderService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";

/** Opening a folder that is already on the disk.
 *
 *  Three routes, and the split is deliberate: what may be opened is a property
 *  of the deployment, walking is how a folder gets chosen, and opening is the
 *  only one that writes anything. All three go through `resolveLocalFolder`,
 *  which is the check that keeps the second from being a directory listing over
 *  the whole host.
 */

const openFolderSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(100).optional(),
});

const browseSchema = z.object({
  path: z.string().trim().min(1).max(4096),
});

/** What this deployment allows, so the screen can say "not configured" rather
 *  than offering a picker that refuses everything. */
export async function localFolderSettingsController(
  _req: Request,
  res: Response,
): Promise<void> {
  res.json({ success: true, data: localFolderSettings() });
  await Promise.resolve();
}

export async function browseLocalFoldersController(
  req: Request,
  res: Response,
): Promise<void> {
  const { path: parent } = browseSchema.parse(req.query ?? {});
  const entries = await browseLocalFolders(parent);

  res.json({ success: true, data: { path: parent, entries } });
}

export async function openLocalFolderController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { path: candidate, name } = openFolderSchema.parse(req.body ?? {});

  const project = await openLocalFolderService(userId, candidate, { name });

  res.status(201).json({
    success: true,
    message: "Folder opened",
    data: project,
  });
}
