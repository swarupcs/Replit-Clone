import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { planBrowserPreview } from "../service/browserPreviewService.js";

/** What a browser needs to preview a project itself. plan.md §13.2.
 *
 *  `visitor`, which is the weakest level this codebase has, and deliberately:
 *  the entire point of this row is the reader of a shared link and the reader
 *  of an embed. An endpoint that required an account would serve nobody it was
 *  built for.
 */
export async function browserPreviewController(
  req: Request,
  res: Response,
): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  await assertProjectAccess(projectId, getAuthContext(req).userId, "visitor");

  res.json({
    success: true,
    message: "Browser preview",
    data: await planBrowserPreview(projectId),
  });
}
