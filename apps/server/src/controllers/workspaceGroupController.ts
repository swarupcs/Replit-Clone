import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { getRepo, githubToken } from "../service/githubService.js";
import { importRepository } from "../service/repoImportService.js";
import {
  groupFor,
  joinGroup,
  listGroups,
  setGroupEnvVars,
  siblingsOf,
} from "../service/workspaceGroupService.js";

/** Several checkouts of one repository. plan.md §13.4. */

const NAME = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._\-/]+$/;

export const checkoutSchema = z.object({
  owner: z.string().min(1).max(100).regex(NAME),
  repo: z.string().min(1).max(100).regex(NAME),
  /** The branch this checkout is of. The repository's default when absent. */
  ref: z.string().min(1).max(255).regex(REF).optional(),
  name: z.string().min(1).max(100).optional(),
});

export async function listGroupsController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  res.json({ success: true, message: "Workspace groups", data: await listGroups(userId) });
}

export async function siblingsController(req: Request, res: Response) {
  // No project-access check beyond the list itself: `siblingsOf` returns the
  // other checkouts of the same group, and a group belongs to one account.
  const { userId } = getAuthContext(req);
  const groups = await listGroups(userId);
  const projectId = String(req.params["projectId"] ?? "");

  const owns = groups.some((group) => group.checkouts.some((c) => c.id === projectId));
  if (!owns) {
    res.json({ success: true, message: "No siblings", data: [] });
    return;
  }

  const siblings = await siblingsOf(projectId);
  res.json({
    success: true,
    message: "Other checkouts",
    data: siblings.map((project) => ({ id: project.id, name: project.name })),
  });
}

/** A second checkout of a repository already on this account.
 *
 *  This is the row's actual ask: reviewing a colleague's branch without putting
 *  your own work down. `switchBranch` refuses on a dirty worktree and changes
 *  the branch in place when it does not, so the only way to have both at once
 *  is to have two.
 */
export async function addCheckoutController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const parsed = checkoutSchema.parse(req.body);

  const token = await githubToken(userId);
  const descriptor = await getRepo(token, parsed.owner, parsed.repo);

  // The ordinary import path, unchanged — including its size check, which
  // refuses a repository too big for the quota before anything is downloaded.
  // A second checkout costs a second working tree, so that check matters more
  // here rather than less.
  const project = await importRepository(userId, parsed, descriptor);

  await joinGroup(project.id, userId, parsed.owner, parsed.repo);
  const group = await groupFor(userId, parsed.owner, parsed.repo);

  res.status(201).json({
    success: true,
    message: "Checkout created",
    data: { projectId: project.id, groupId: group.id },
  });
}

export const groupEnvSchema = z.object({ envVars: z.unknown() });

export async function setGroupEnvController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const groupId = String(req.params["groupId"] ?? "");
  const { envVars } = groupEnvSchema.parse(req.body);

  const saved = await setGroupEnvVars(groupId, userId, envVars);
  res.json({ success: true, message: "Saved", data: saved });
}
