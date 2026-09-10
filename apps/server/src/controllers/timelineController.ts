import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import {
  listCheckpoints,
  readCheckpoint,
} from "../service/checkpointService.js";

/** A file's own history. plan.md §10.12.
 *
 *  **The row's premise was half wrong and finding that out is the work.** It
 *  says checkpoints "are the wrong granularity — whole-project, explicit". They
 *  are neither: `snapshot()` is called per file on every save, automatically,
 *  from the write handler, and has been since §2.x. What was actually missing
 *  is that **nothing could read them** — `listCheckpoints` and `readCheckpoint`
 *  existed with no route, no client and no UI, so the answer to "what did this
 *  look like an hour ago" was on disk and unreachable.
 *
 *  What is still true from the row: they live on the same disk as the tree they
 *  snapshot, so they are not a backup. §3.3 is the backup, and it says so.
 */

function pathFrom(req: Request): string {
  const value = req.query["path"];
  return typeof value === "string" ? value : "";
}

export async function timelineController(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const relPath = pathFrom(req);
  if (relPath === "") {
    res.status(400).json({ success: false, message: "A path is required" });
    return;
  }

  res.json({
    success: true,
    message: "Timeline",
    data: await listCheckpoints(projectId, relPath),
  });
}

export async function timelineVersionController(
  req: Request,
  res: Response,
): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  const relPath = pathFrom(req);
  const at = Number(req.query["at"]);

  const contents = await readCheckpoint(projectId, relPath, at);
  if (contents === null) {
    // A version that has been pruned away is the ordinary case -- the service
    // keeps a bounded number -- so this is a 404 with a sentence rather than a
    // 500, and the panel can say "that one is gone" instead of "error".
    res.status(404).json({ success: false, message: "That version is no longer kept" });
    return;
  }

  res.json({ success: true, message: "Version", data: { at, contents } });
}
