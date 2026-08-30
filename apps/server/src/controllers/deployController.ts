import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { z } from "zod";
import {
  deploymentState,
  publish,
  unpublish,
} from "../service/deployService.js";
import {
  claimDomain,
  releaseDomain,
  verifyDomain,
} from "../service/customDomainService.js";

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

/* ---- custom domains ---- */

/** The owner's alone, like publishing and for the same reason.
 *
 *  Pointing a name at a deployment is a decision about an address the whole
 *  internet reaches, and an editor having write access to a file is not the
 *  same decision. Verification is owner-only too even though it only reads
 *  DNS: it is the step that makes the address live.
 */
const domainSchema = z.object({
  // Length and shape are settled in `normalizeDomain`, which produces errors
  // that say what to do next. This bound only keeps an unreasonable body out
  // of the parser.
  domain: z.string().min(1).max(300),
});

export async function claimDomainController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const { domain } = domainSchema.parse(req.body);

  res.json({
    success: true,
    message:
      "Domain claimed. Add the TXT record shown, then verify — DNS usually " +
      "propagates within a few minutes.",
    data: await claimDomain({ projectId, domain }),
  });
}

export async function verifyDomainController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");

  res.json({
    success: true,
    message: "Domain verified. It is serving now.",
    data: await verifyDomain(projectId),
  });
}

export async function releaseDomainController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  await releaseDomain(projectId);

  res.json({
    success: true,
    message: "Domain removed",
    data: await deploymentState(projectId),
  });
}
