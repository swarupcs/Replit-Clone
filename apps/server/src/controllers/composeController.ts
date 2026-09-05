import type { Request, Response } from "express";
import type { ComposeState } from "@replit-clone/shared";
import { env } from "../config/env.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { describeServices } from "../containers/composeServices.js";

/** What the project's own docker-compose.yml declares, and what is running.
 *
 *  plan.md §11.3. The file is re-read on every call rather than reported from
 *  the last start, for the reason the devcontainer endpoint is: somebody who
 *  has just edited it is exactly the person opening this panel, and telling
 *  them about the previous version would be worse than saying nothing.
 */
export async function getComposeController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, "viewer");

  const status = await describeServices(projectId);
  const declared = new Map(
    (status.project?.services ?? []).map((service) => [service.name, service]),
  );

  const state: ComposeState = {
    source: status.project?.source ?? null,
    appService: status.project?.appService ?? null,
    unsupported: status.project?.unsupported ?? [],
    error: status.error,
    enabled: status.enabled,
    allowedImages: env.COMPOSE_IMAGE_ALLOWLIST,
    maxServices: env.COMPOSE_MAX_SERVICES,
    services: status.services.map((service) => ({
      name: service.name,
      image: service.image,
      ports: service.ports,
      // NAMES only. The values are in the repository already, but this
      // endpoint explains a file rather than handing its contents back — and a
      // compose file is exactly where somebody's first password ends up.
      envNames: Object.keys(declared.get(service.name)?.env ?? {}).sort(),
      status: service.status,
      refusal: service.refusal,
    })),
  };

  res.json({ success: true, message: "Compose services", data: state });
}
