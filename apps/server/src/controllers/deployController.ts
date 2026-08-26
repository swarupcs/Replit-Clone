import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  deploymentState,
  publish,
  unpublish,
} from "../service/deployService.js";

/** Who may do what with a deployment.
 *
 *  Reading is a viewer's business — a collaborator should be able to see
 *  whether a site is live and where. Publishing and unpublishing are the
 *  owner's alone, and deliberately NOT an editor's: this is the one action in
 *  the product that puts a project in front of the entire internet, and
 *  "somebody was given write access to a file" is not the same decision as
 *  "somebody may publish this".
 */
async function authorise(
  req: Request,
  level: "viewer" | "owner",
): Promise<string> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, level);
  return projectId;
}

export async function getDeploymentController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Deployment",
    data: await deploymentState(projectId),
  });
}

export async function deployController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const deployment = await publish(projectId);

  res.json({
    success: true,
    message: "Deployed",
    data: deployment,
  });
}

export async function undeployController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  await unpublish(projectId);

  res.json({
    success: true,
    message: "Taken offline",
    data: await deploymentState(projectId),
  });
}
