import type { Request, Response } from "express";
import type { DevcontainerState } from "@replit-clone/shared";
import { env } from "../config/env.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  getDevcontainerStatus,
  readDevcontainer,
  DevcontainerError,
  type DevcontainerConfig,
} from "../containers/devcontainer.js";
import { runningImage } from "../containers/containerManager.js";

function summarise(config: DevcontainerConfig) {
  return {
    source: config.source,
    requestedImage: config.image ?? null,
    forwardPorts: config.forwardPorts ?? [],
    // NAMES only. The values are the user's own, but they are also the shape
    // secrets take, and this endpoint exists to explain a config rather than to
    // hand its contents back.
    containerEnvNames: Object.keys(config.containerEnv ?? {}).sort(),
    postCreateCommand: config.postCreateCommand ?? [],
    postStartCommand: config.postStartCommand ?? [],
    workspaceFolder: config.workspaceFolder ?? null,
    unsupported: config.unsupported,
  };
}

/** What the project's devcontainer config is and what it did.
 *
 *  The file is re-read here rather than only reported from the last start, so
 *  the dialog shows what is in the file NOW — somebody who has just edited it
 *  is exactly the person opening this, and telling them about the previous
 *  version would be worse than saying nothing.
 */
export async function getDevcontainerController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, "viewer");

  const status = getDevcontainerStatus(projectId);

  let config: DevcontainerConfig | null = null;
  let error: string | null = status.error;

  try {
    config = await readDevcontainer(projectId);
    // A file that parses now supersedes an error from a previous start: the
    // user has fixed it, and the next start will pick it up.
    if (config) error = status.config ? status.error : null;
  } catch (readError) {
    config = null;
    error =
      readError instanceof DevcontainerError
        ? readError.message
        : "The devcontainer config could not be read.";
  }

  const state: DevcontainerState = {
    config: config ? summarise(config) : null,
    imageInUse: await runningImage(projectId),
    error,
    lifecycleLog: status.lifecycleLog,
    running: status.running,
    allowedImages: env.DEVCONTAINER_IMAGE_ALLOWLIST,
  };

  res.json({ success: true, message: "Dev container", data: state });
}
