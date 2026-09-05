import type { Request, Response } from "express";
import type { GitPushSkipReason } from "@replit-clone/shared";
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

/** A sync: everything optional, because the point of it is not having to say.
 *
 *  An omitted remote means `origin`, and an omitted branch means the one HEAD
 *  is on. Both are still validated when given, by the same rules a pull uses —
 *  a convenience that accepted a looser name than the explicit route would be
 *  a way around that route.
 */
const syncSchema = z.object({
  name: pullSchema.shape.name.optional(),
  branch: pullSchema.shape.branch.optional(),
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

/** The stored GitHub token, but only for a remote that is actually GitHub.
 *
 *  git's credential helper answers whatever host git asks it about — it is
 *  handed the request on stdin and prints a password regardless. So spending
 *  the connection on a remote pointing anywhere else hands somebody's GitHub
 *  token to that host.
 *
 *  Remotes are added at *editor* level and may name any https host, while
 *  pushing is the owner's. Those do not overlap today — a project with an
 *  editor has a collaborator, and a project with a collaborator cannot be
 *  pushed from here at all — but they only have to overlap once: a
 *  collaborator adds a mirror, is removed, and the next owner push sends the
 *  token to them. A README saying "add this remote and push" needs no
 *  collaborator at all.
 *
 *  A pasted token is unaffected: choosing to give a credential to a particular
 *  remote is exactly what typing one in means.
 */
async function githubForRemote(
  projectId: string,
  name: string,
  userId: string,
): Promise<string> {
  const remote = (await git.remotes(projectId)).find(
    (entry) => entry.name === name,
  );

  if (!remote || !parseGithubRemote(remote.url)) {
    throw new BadRequestError(
      `${name} is not a GitHub remote, so your connected GitHub account ` +
        "cannot be used for it. Supply an access token for this push instead.",
      "REMOTE_NOT_GITHUB",
    );
  }

  return githubToken(userId);
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
  const credential = token ?? (await githubForRemote(projectId, name, userId));

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


/** Which GitHub repository this project points at, if any.
 *
 *  Lets the panel offer a pull request and an "open on GitHub" link only when
 *  there is somewhere for them to go — better than offering both and failing on
 *  a project whose remote is a GitLab one or a path on disk.
 */
export async function githubRepoController(
  req: Request,
  res: Response,
): Promise<void> {
  const projectId = await authorise(req, "viewer");

  const remotes = await git.remotes(projectId);
  const ordered = [
    ...remotes.filter((remote) => remote.name === "origin"),
    ...remotes.filter((remote) => remote.name !== "origin"),
  ];

  const found = ordered
    .map((remote) => parseGithubRemote(remote.url))
    .find((parsed) => parsed !== null);

  res.json({
    success: true,
    message: "GitHub repository",
    data: found
      ? { ...found, url: `https://github.com/${found.owner}/${found.repo}` }
      : null,
  });
}

/** Fetch, fast-forward, push — in that order, in one call.
 *
 *  Every leg of this already exists as its own route, and this deliberately
 *  calls those same services rather than reaching for git itself: a sync that
 *  could pull something `/git/pull` would refuse, or push where `/git/push`
 *  would not, would be a second set of rules for the same operations and the
 *  looser of the two would become the real one.
 *
 *  **The order is not arbitrary.** Pushing before pulling is how a
 *  non-fast-forward rejection happens on the forge instead of here, and
 *  fetching before both is what makes `ahead`/`behind` describe the remote as
 *  it is now rather than as it was at the last fetch.
 *
 *  **A pull that cannot fast-forward stops the sync**, and says so. `--ff-only`
 *  is the service's choice and this does not widen it: the alternative is
 *  deciding on somebody's behalf between a merge commit and a rebase, in a
 *  worktree they have open, over commits this server has not shown them.
 *
 *  **A push that cannot happen does not fail the sync.** Being unable to push
 *  is a property of the project (shared) or the account (no credential), not of
 *  this request, and throwing away a successful pull to report it would make
 *  the button useless exactly where it is most wanted — a shared project that
 *  still needs to receive other people's commits.
 */
export async function gitSyncController(
  req: Request,
  res: Response,
): Promise<void> {
  // Editor, not owner. The push leg re-checks ownership for itself below;
  // requiring it up front would refuse a collaborator the fetch-and-pull half,
  // which is theirs by the same right `/git/pull` grants it.
  const projectId = await authorise(req, "editor");
  const { userId } = getAuthContext(req);
  const { name, branch, token } = syncSchema.parse(req.body ?? {});

  const before = await git.status(projectId);
  if (!before.isRepo) {
    throw new BadRequestError(
      "This project has no git repository yet.",
      "NOT_A_REPO",
    );
  }
  if (before.unborn || !before.branch) {
    throw new BadRequestError(
      "This branch has no commits yet, so there is nothing to sync. Commit first.",
      "UNBORN_BRANCH",
    );
  }

  const available = await git.remotes(projectId);
  if (available.length === 0) {
    throw new BadRequestError(
      "This project has no remote. Add one, then sync.",
      "NO_REMOTE",
    );
  }

  // `origin` by default, but not blindly: a repository whose only remote is
  // called something else should sync to that rather than report a remote it
  // does not have missing.
  const remote =
    name ??
    (available.find((entry) => entry.name === "origin") ?? available[0]!).name;

  if (!available.some((entry) => entry.name === remote)) {
    throw new BadRequestError(`No remote called ${remote}.`, "NO_SUCH_REMOTE");
  }

  const target = branch ?? before.branch;

  await git.fetchRemote(projectId, remote);

  const fetched = await git.status(projectId);
  const behind = fetched.behind ?? 0;

  if (behind > 0) {
    // Let the service refuse a dirty worktree. Checking here as well would put
    // the same rule in two places, and this one would be the stale copy.
    await git.pullRemote(projectId, remote, target);

    // Same reason as `/git/pull`: the worktree was rewritten underneath any
    // live shared document, which would otherwise write its pre-pull text back
    // over what was just merged in.
    forgetProject(projectId);
  }

  const merged = await git.status(projectId);
  const ahead = merged.ahead ?? 0;

  let pushSkipped: GitPushSkipReason | null = null;
  let pushed = 0;

  if (ahead > 0) {
    const reason = await pushBlocker(projectId, userId, remote, token);
    if (reason) {
      pushSkipped = reason;
    } else {
      const credential =
        token ?? (await githubForRemote(projectId, remote, userId));
      await git.pushRemote(projectId, remote, target, credential);
      pushed = ahead;
    }
  }

  const status = await git.status(projectId);

  res.json({
    success: true,
    message: "Synced",
    data: {
      status,
      remote,
      branch: target,
      pulled: behind,
      pushed,
      pushSkipped,
      summary: describeSync(behind, pushed, pushSkipped, remote),
    },
  });
}

/** Why this caller cannot push here, or null when they can.
 *
 *  Asked BEFORE the push rather than catching its failure, because the two
 *  refusals this reports are not failures: they are states the project is in,
 *  and one of them (a shared container) must be decided before a credential is
 *  fetched rather than after.
 */
async function pushBlocker(
  projectId: string,
  userId: string,
  remote: string,
  token: string | undefined,
): Promise<GitPushSkipReason | null> {
  // Ownership, checked the way the push route checks it. `assertProjectAccess`
  // throws, and here that is an answer rather than an error.
  try {
    await assertProjectAccess(projectId, userId, "owner");
  } catch {
    return "PROJECT_IS_SHARED";
  }

  if (!(await isSoleOccupant(projectId))) return "PROJECT_IS_SHARED";

  // A pasted token pays for any remote, so nothing else needs checking.
  if (token) return null;

  const entry = (await git.remotes(projectId)).find((r) => r.name === remote);
  if (!entry || !parseGithubRemote(entry.url)) return "REMOTE_NOT_GITHUB";

  const connection = await prisma.githubConnection.findUnique({
    where: { userId },
    select: { userId: true },
  });

  return connection ? null : "NO_CREDENTIAL";
}

/** One line saying what happened, composed here so every client says it the
 *  same way. */
function describeSync(
  pulled: number,
  pushed: number,
  skipped: GitPushSkipReason | null,
  remote: string,
): string {
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const parts: string[] = [];

  if (pulled > 0) parts.push(`pulled ${commits(pulled)}`);
  if (pushed > 0) parts.push(`pushed ${commits(pushed)}`);

  if (parts.length === 0 && !skipped) {
    return `Already up to date with ${remote}.`;
  }

  const did = parts.length > 0 ? `Synced with ${remote}: ${parts.join(", ")}.` : "";

  if (!skipped) return did;

  const why =
    skipped === "PROJECT_IS_SHARED"
      ? "Not pushed: this project is shared, so a token used here would be " +
        "readable by everyone with access. Push from the terminal instead."
      : skipped === "REMOTE_NOT_GITHUB"
        ? `Not pushed: ${remote} is not a GitHub remote, so your connected ` +
          "account cannot be used for it."
        : "Not pushed: connect GitHub, or supply an access token.";

  return did ? `${did} ${why}` : why;
}
