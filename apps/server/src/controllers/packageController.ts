import type { Request, Response } from "express";
import { z } from "zod";
import { MAX_PACKAGE_NAME, MAX_PACKAGE_VERSION } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  addPackage,
  listPackages,
  removePackage,
} from "../service/packageService.js";

/** Reading what a project depends on is a viewer's business. Installing runs a
 *  package manager inside the container and changes the manifest, so it needs
 *  the same write access the editor needs. */
async function authorise(
  req: Request,
  level: "viewer" | "editor",
): Promise<string> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, level);
  return projectId;
}

/** Shape only. What a name and a version may actually CONTAIN is decided in
 *  the service, per ecosystem, next to the reason those rules exist. */
const addSchema = z.object({
  name: z.string().trim().min(1).max(MAX_PACKAGE_NAME),
  version: z.string().trim().max(MAX_PACKAGE_VERSION).optional(),
  dev: z.boolean().optional(),
});

const removeSchema = z.object({
  name: z.string().trim().min(1).max(MAX_PACKAGE_NAME),
});

export async function listPackagesController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Packages",
    data: await listPackages(projectId),
  });
}

export async function addPackageController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name, version, dev } = addSchema.parse(req.body);

  res.json({
    success: true,
    message: `Installed ${name}`,
    data: await addPackage(projectId, name, version ?? "", dev ?? false),
  });
}

export async function removePackageController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name } = removeSchema.parse(req.body);

  res.json({
    success: true,
    message: `Removed ${name}`,
    data: await removePackage(projectId, name),
  });
}
