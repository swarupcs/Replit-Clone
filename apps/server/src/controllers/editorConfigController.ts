import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { readEditorConfig } from "../service/editorConfigService.js";

/** What the repository says about the editor. plan.md §10.9.
 *
 *  Viewer, not editor: these are files in the tree, and anybody who can read
 *  the tree can read them. Refusing here would mean a read-only visitor's
 *  editor silently ignoring a `settings.json` they can see in the file list.
 */
export async function getEditorConfigController(
  req: Request,
  res: Response,
): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const data = await readEditorConfig(projectId);
  res.json({ success: true, message: "Editor config", data });
}
