import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import {
  resolveTestCommand,
  runTests,
  setTestCommand,
} from "../service/testRunService.js";

/** Reading the command is a viewer's; running it and changing it are not.
 *
 *  Running tests executes arbitrary code in the project's container, which is
 *  the same grant `Run` needs and not one read-only access implies. Changing
 *  what runs is the owner's, on the reasoning §2.13 gives about schedules:
 *  "may edit a file" and "may choose the command this project executes" are
 *  different grants, and the second is the shape of a backdoor.
 */
async function authorise(
  req: Request<{ projectId: string }>,
  level: "viewer" | "editor" | "owner",
): Promise<string> {
  const projectId = assertValidProjectId(req.params.projectId);
  await assertProjectAccess(projectId, getAuthContext(req).userId, level);
  return projectId;
}

const commandSchema = z.object({ command: z.string().max(500) });

export async function getTestCommandController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");

  res.json({
    success: true,
    message: "Test command",
    data: await resolveTestCommand(projectId),
  });
}

export async function setTestCommandController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const { command } = commandSchema.parse(req.body ?? {});

  res.json({
    success: true,
    message: "Test command saved",
    data: await setTestCommand(projectId, command),
  });
}

export async function runTestsController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");

  res.json({
    success: true,
    message: "Tests run",
    data: { run: await runTests(projectId) },
  });
}
