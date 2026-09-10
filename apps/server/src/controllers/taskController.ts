import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { readTasks, runTask } from "../service/taskService.js";

/** Tasks from the repository. plan.md §10.10. */

export async function listTasksController(
  req: Request,
  res: Response,
): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  // A viewer may SEE what tasks exist -- they are a file in the tree, and
  // hiding them would mean a list that disagrees with the file list.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "viewer");

  res.json({ success: true, message: "Tasks", data: await readTasks(projectId) });
}

export async function runTaskController(req: Request, res: Response): Promise<void> {
  const { projectId } = req.params as { projectId: string };
  // Running one is `editor`: a task is an arbitrary command line from the
  // repository, and running it is running code in the container.
  await assertProjectAccess(projectId, getAuthContext(req).userId, "editor");

  const { label } = req.body as { label?: string };
  if (typeof label !== "string" || label.trim() === "") {
    res.status(400).json({ success: false, message: "A task label is required" });
    return;
  }

  res.json({
    success: true,
    message: "Task run",
    data: await runTask(projectId, label.trim()),
  });
}
