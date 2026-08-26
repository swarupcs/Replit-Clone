import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import { BadRequestError } from "../utils/errors.js";
import { prisma } from "../lib/prisma.js";
import * as git from "../service/gitService.js";
import { dropDoc, forgetProject } from "../service/collabService.js";
import {
  createPullRequest,
  githubToken,
  listPullRequests,
  parseGithubRemote,
} from "../service/githubService.js";

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
/** Which hunks of one file to stage, and in which direction.
 *
 *  Indexes into the diff the SERVER produces, never patch text: a
 *  client-authored patch handed to `git apply` could stage a change to a path
 *  nobody chose. */
const hunksSchema = z.object({
  path: relativePath,
  indexes: z.array(z.number().int().nonnegative()).min(1).max(500),
  reverse: z.boolean().optional(),
});

/** A remote's name and, when adding one, its URL. The URL's transport is
 *  checked in the service, where the reason it matters lives. */
const remoteSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-"), {
      message: "Remote name must not start with a dash",
    }),
  url: z.string().trim().min(1).max(2048).optional(),
  remove: z.boolean().optional(),
});

const pullSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-")),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !value.startsWith("-")),
});

/** A push: where to, which branch, and the credential for this one call.
 *
 *  The token is never persisted or echoed, so nothing here validates its shape
 *  beyond a length bound — every forge issues a different one, and guessing at
 *  formats would only reject valid credentials. */
/** The token is optional now: a connected GitHub account supplies one, and
 *  pasting a personal access token remains the way to push anywhere else. */
const pushSchema = pullSchema.extend({
  token: z.string().min(1).max(1024).optional(),
});

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
 *  repository, so they need write access -- the same line the editor draws.
 *  Pushing is the owner's alone, because it spends the owner's credential. */
async function authorise(
  req: Request,
  level: "viewer" | "editor" | "owner",
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

/** Throws away local changes to the named paths.
 *
 *  Destructive and not undoable, so it is the owner's-and-editor's business
 *  only and the UI confirms first.
 *
 *  Each discarded path's shared document is dropped: a live Yjs document still
 *  holding the edited text would write it straight back over the version just
 *  restored, which would make the discard look like it silently failed. Dropped
 *  per path rather than for the whole project, so files nobody asked about keep
 *  their in-flight edits.
 */
export async function gitDiscardController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { paths } = pathsSchema.parse(req.body ?? {});

  await git.discard(projectId, paths);

  for (const path of paths) dropDoc(projectId, path);

  res.json({
    success: true,
    message: "Discarded",
    data: await git.status(projectId),
  });
}

/** Stages, or unstages, individual hunks of one file.
 *
 *  Only the index moves, so nothing on disk changes and no shared document
 *  needs dropping -- unlike a branch switch or a discard.
 */
export async function gitHunksController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { path, indexes, reverse } = hunksSchema.parse(req.body ?? {});

  await git.applyHunks(projectId, path, indexes, reverse ?? false);

  res.json({
    success: true,
    message: reverse ? "Unstaged" : "Staged",
    data: await git.status(projectId),
  });
}

export async function gitRemotesController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");

  res.json({
    success: true,
    message: "Remotes",
    data: await git.remotes(projectId),
  });
}

/** Adds or removes a remote. */
export async function gitRemoteController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name, url, remove } = remoteSchema.parse(req.body ?? {});

  if (remove) {
    await git.removeRemote(projectId, name);
  } else {
    if (!url) throw new BadRequestError("A remote needs a URL");
    await git.addRemote(projectId, name, url);
  }

  res.json({
    success: true,
    message: remove ? "Remote removed" : "Remote added",
    data: await git.remotes(projectId),
  });
}

/** Fetches from a remote. Touches no file in the worktree. */
export async function gitFetchController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name } = remoteSchema.parse(req.body ?? {});

  await git.fetchRemote(projectId, name);

  res.json({
    success: true,
    message: "Fetched",
    data: await git.status(projectId),
  });
}

/** Pulls a branch. Rewrites the worktree, so shared documents are dropped
 *  afterwards -- a live one would write the pre-pull text back over what was
 *  just merged in. */
export async function gitPullController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "editor");
  const { name, branch } = pullSchema.parse(req.body ?? {});

  await git.pullRemote(projectId, name, branch);

  forgetProject(projectId);

  res.json({
    success: true,
    message: "Pulled",
    data: await git.status(projectId),
  });
}

/** Whether this project's container belongs to one person.
 *
 *  A push needs a credential, and a credential is only ever as private as the
 *  container it is used in. Every collaborator works in the SAME container, so
 *  on a shared project anything handed to git there is reachable by whatever
 *  code anyone with access runs — which would make this feature a way to walk
 *  off with the owner's account.
 *
 *  An unredeemed share link counts as sharing: it is an invitation outstanding,
 *  and it can be redeemed while a push is in flight.
 */
async function isSoleOccupant(projectId: string): Promise<boolean> {
  const [collaborators, project] = await Promise.all([
    prisma.projectCollaborator.count({ where: { projectId } }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { shareToken: true },
    }),
  ]);

  return collaborators === 0 && !project?.shareToken;
}

/** Pushes a branch, with a token supplied for this one call.
 *
 *  The owner's alone — not because an editor could not be trusted with the
 *  repository, but because the token is the owner's and the container is not
 *  private to them once anyone else has access. Refused rather than quietly
 *  weakened, and the message says where pushing does still work: the project's
 *  own terminal, where the secret is typed into the user's own session and
 *  never passes through this server.
 */
export async function gitPushController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const { userId } = getAuthContext(req);
  const { name, branch, token } = pushSchema.parse(req.body ?? {});

  if (!(await isSoleOccupant(projectId))) {
    throw new BadRequestError(
      "This project is shared, so a token used here would be readable by " +
        "everyone with access. Push from the project's terminal instead.",
      "PROJECT_IS_SHARED",
    );
  }

  // A token in the request wins: someone pasting one is pushing to a forge
  // this server knows nothing about, and their explicit choice should not be
  // overridden by a connection meant for GitHub.
  const credential = token ?? (await githubToken(userId));

  await git.pushRemote(projectId, name, branch, credential);

  res.json({
    success: true,
    message: "Pushed",
    data: await git.status(projectId),
  });
}

/** Where this project's code lives on GitHub, from its own remotes.
 *
 *  Derived rather than asked for: the browser knowing which repository a
 *  project belongs to would be a thing to get wrong or to lie about, and the
 *  remote is the authority anyway.
 *
 *  `origin` first, then any other GitHub remote — a fork's `origin` is the
 *  fork, which is exactly where a pull request should come from.
 */
async function githubRepoForProject(
  projectId: string,
): Promise<{ owner: string; repo: string }> {
  const remotes = await git.remotes(projectId);
  const ordered = [
    ...remotes.filter((remote) => remote.name === "origin"),
    ...remotes.filter((remote) => remote.name !== "origin"),
  ];

  for (const remote of ordered) {
    const parsed = parseGithubRemote(remote.url);
    if (parsed) return parsed;
  }

  throw new BadRequestError(
    "This project has no GitHub remote, so there is nowhere to open a pull " +
      "request. Add one first.",
    "NO_GITHUB_REMOTE",
  );
}

export async function githubPullsController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");
  const { userId } = getAuthContext(req);

  const head = typeof req.query["head"] === "string" ? req.query["head"] : undefined;
  const { owner, repo } = await githubRepoForProject(projectId);

  res.json({
    success: true,
    message: "Pull requests",
    data: await listPullRequests(userId, owner, repo, head),
  });
}

const pullRequestSchema = z.object({
  title: z.string().trim().min(1).max(255),
  head: z.string().trim().min(1).max(255),
  base: z.string().trim().min(1).max(255),
  body: z.string().max(60_000).optional(),
  draft: z.boolean().optional(),
});

/** Opens a pull request.
 *
 *  The owner's, like pushing, and for the same reason: it spends their
 *  credential and speaks in their name on a repository that is theirs.
 */
export async function githubCreatePullController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "owner");
  const { userId } = getAuthContext(req);
  const input = pullRequestSchema.parse(req.body ?? {});

  const { owner, repo } = await githubRepoForProject(projectId);

  res.status(201).json({
    success: true,
    message: "Pull request opened",
    data: await createPullRequest(userId, { owner, repo, ...input }),
  });
}
