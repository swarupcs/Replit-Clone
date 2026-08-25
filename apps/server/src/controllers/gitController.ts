import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { prisma } from "../lib/prisma.js";
import * as git from "../service/gitService.js";
import { forgetProject } from "../service/collabService.js";

/** Paths come from the client, so they are constrained the same way the editor
 *  constrains them: relative, and unable to climb out of the project.
 *
 *  git itself would refuse an absolute path outside the work tree, but it is
 *  cheaper to reject it here than to rely on that. */
const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.startsWith("-"), {
    message: "Path must be relative",
  })
  .refine(
    (value) =>
      !value.split(/[\\/]/).some((segment) => segment === ".."),
    { message: "Path escapes the project" },
  );

const pathsSchema = z.object({ paths: z.array(relativePath).min(1).max(500) });
const commitSchema = z.object({ message: z.string().trim().min(1).max(2000) });

/** A branch name, plus whether to create it.
 *
 *  Only the shape is checked here -- git's own `check-ref-format` is the
 *  authority on what a ref may be called, and the service asks it. The leading
 *  dash is rejected at both layers because such a name would be read as an
 *  option by the command asked to validate it. */
const branchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-"), {
      message: "Branch name must not start with a dash",
    }),
  create: z.boolean().optional(),
});
const diffQuerySchema = z.object({
  path: relativePath,
  staged: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

/** Resolves the project and the caller's right to act on it.
 *
 *  Reading history is a viewer's business; staging and committing change the
 *  repository, so they need write access -- the same line the editor draws. */
async function authorise(
  req: Request,
  level: "viewer" | "editor",
): Promise<string> {
  const { userId } = getAuthContext(req);
  const projectId = assertValidProjectId(req.params["projectId"] ?? "");
  await assertProjectAccess(projectId, userId, level);
  return projectId;
}

export async function gitStatusController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  res.json({
    success: true,
    message: "Git status",
    data: await git.status(projectId),
  });
}

export async function gitInitController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  res.json({
    success: true,
    message: "Repository initialised",
    data: await git.init(projectId),
  });
}

export async function gitDiffController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  const { path, staged } = diffQuerySchema.parse(req.query);

  res.json({
    success: true,
    message: "Diff",
    data: { path, staged, patch: await git.diff(projectId, path, staged) },
  });
}

export async function gitStageController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { paths } = pathsSchema.parse(req.body ?? {});

  await git.stage(projectId, paths);
  res.json({
    success: true,
    message: "Staged",
    data: await git.status(projectId),
  });
}

export async function gitUnstageController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { paths } = pathsSchema.parse(req.body ?? {});

  await git.unstage(projectId, paths);
  res.json({
    success: true,
    message: "Unstaged",
    data: await git.status(projectId),
  });
}

export async function gitCommitController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const projectId = await authorise(req, "editor");
  const { message } = commitSchema.parse(req.body ?? {});

  // The commit is attributed to whoever made it, not to the project's owner --
  // a shared project has several people committing into one repository.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const email = user?.email ?? "unknown@example.com";

  const commits = await git.commit(projectId, message, {
    name: email.split("@")[0] ?? "user",
    email,
  });

  res.json({
    success: true,
    message: "Committed",
    data: { status: await git.status(projectId), commits },
  });
}

export async function gitLogController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  const limit = Math.min(Number(req.query["limit"] ?? 20) || 20, 100);

  res.json({
    success: true,
    message: "History",
    data: await git.history(projectId, limit),
  });
}

export async function gitBranchesController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");

  res.json({
    success: true,
    message: "Branches",
    data: await git.branches(projectId),
  });
}

/** Creates a branch, or switches to one.
 *
 *  One route for both because the panel does them from the same control, and
 *  both answer with the same pair -- the resulting status and branch list --
 *  so the panel redraws from a single round trip.
 *
 *  Switching rewrites the worktree under anyone with the project open, so every
 *  shared document is dropped afterwards: a live Yjs document still holding the
 *  old branch's text would otherwise write it back over the new one.
 */
export async function gitBranchController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name, create } = branchSchema.parse(req.body ?? {});

  if (create) await git.createBranch(projectId, name);
  else await git.switchBranch(projectId, name);

  forgetProject(projectId);

  res.json({
    success: true,
    message: create ? "Branch created" : "Switched branch",
    data: {
      status: await git.status(projectId),
      branches: await git.branches(projectId),
    },
  });
}
