import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import {
  getEditorSession,
  setEditorSession,
} from "../service/editorSessionService.js";

/** Where the editor was left. plan.md §13.11.
 *
 *  Scoped to the caller and nothing else: the user id comes from the auth
 *  context, never from the request, so there is no shape of this endpoint that
 *  reads another account's session.
 */

export async function getEditorSessionController(
  req: Request,
  res: Response,
): Promise<void> {
  const data = await getEditorSession(getAuthContext(req).userId);
  res.json({ success: true, message: "Editor session", data });
}

export async function setEditorSessionController(
  req: Request,
  res: Response,
): Promise<void> {
  const data = await setEditorSession(getAuthContext(req).userId, req.body);
  res.json({ success: true, message: "Editor session saved", data });
}
