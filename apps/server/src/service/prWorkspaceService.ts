import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { githubApi, githubToken, getRepo } from "./githubService.js";
import { importRepository } from "./repoImportService.js";
import { publish, siteUrl } from "./deployService.js";
import { trashProjectService } from "./projectService.js";
import { joinGroup } from "./workspaceGroupService.js";
import type { WebhookDecision } from "./pullRequestEvent.js";

/** A workspace and a URL per pull request. plan.md §13.3.
 *
 *  The row calls this "the most valuable row in 13A for anybody working with
 *  other people, and the one whose mechanism is most nearly already here", and
 *  that second half is accurate: `repoImportService` clones, `deployService`
 *  publishes, `projectService` has the trash, and `githubService` can post a
 *  comment. What was missing is a receiver and the bookkeeping between them,
 *  which is this file.
 */

/** What one delivery did, for the log and the metrics. Returned rather than
 *  logged-and-swallowed so the route's tests can assert on it. */
export type Outcome =
  | "ping"
  | "ignored"
  | "not-enrolled"
  | "created"
  | "refreshed"
  | "unchanged"
  | "torn-down";

/** GitHub is case-insensitive about owner and repo names and sends whichever
 *  case the event happened to carry. Every read and write of the key goes
 *  through this, or the same pull request gets a second workspace the first
 *  time somebody types the name differently. */
function key(owner: string, repo: string): { owner: string; repo: string } {
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/** At-least-once delivery, and — unlike the billing equivalent — a replay
 *  defence rather than an efficiency measure.
 *
 *  GitHub's signature covers the body and carries no timestamp, so a captured
 *  delivery stays valid forever. Refusing an id already seen is the only thing
 *  standing between that and a replayed `opened` starting another container.
 */
export async function claimDelivery(id: string, event: string): Promise<boolean> {
  try {
    await prisma.webhookDelivery.create({ data: { id, event } });
    return true;
  } catch {
    // The only plausible failure is the unique constraint, and the next copy of
    // this delivery will fail the same way. Anything else is a database that is
    // down, in which case refusing to act is also the right answer.
    increment("github_delivery_duplicate");
    return false;
  }
}

/** Whose account pays for this repository's workspaces, or nobody. */
async function enrolmentFor(owner: string, repo: string): Promise<string | null> {
  const row = await prisma.pullRequestRepo.findUnique({
    where: { owner_repo: key(owner, repo) },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/** The comment body. One link, and what it is.
 *
 *  Kept to a shape that can be recognised again: the next push edits this
 *  comment rather than adding another, and a pull request with fifteen
 *  near-identical bot comments is worse than one with none.
 */
export function commentBody(url: string, sha: string): string {
  return [
    "**Preview workspace**",
    "",
    `${url}`,
    "",
    `Built from \`${sha.slice(0, 7)}\`. It is torn down when this pull request is merged or closed.`,
  ].join("\n");
}

/** Posts the link, or edits the one already posted.
 *
 *  Never throws into the caller: a deployment whose token cannot write to this
 *  repository still gets the workspace, and the comment is the part that is
 *  allowed to fail. Returns the comment id to store, or null.
 */
async function comment(
  userId: string,
  owner: string,
  repo: string,
  number: number,
  existing: string | null,
  body: string,
): Promise<string | null> {
  try {
    const token = await githubToken(userId);

    if (existing) {
      await githubApi(token, `/repos/${owner}/${repo}/issues/comments/${existing}`, {
        method: "PATCH",
        body: { body },
      });
      return existing;
    }

    const { data } = await githubApi<{ id: number }>(
      token,
      `/repos/${owner}/${repo}/issues/${String(number)}/comments`,
      { method: "POST", body: { body } },
    );
    return String(data.id);
  } catch (error: unknown) {
    // Logged and dropped. The workspace is the deliverable; the comment is how
    // somebody finds it, and a deployment with a read-only token should get the
    // first without the second rather than neither.
    logger.warn("could not post the pull request comment", {
      owner,
      repo,
      number,
      error: error instanceof Error ? error.message : String(error),
    });
    increment("github_pr_comment_failed");
    return null;
  }
}

/** Builds or refreshes the workspace for one pull request. */
async function upsert(
  repo: { owner: string; repo: string },
  pull: { number: number; headRef: string; headSha: string; title: string },
): Promise<Outcome> {
  const userId = await enrolmentFor(repo.owner, repo.repo);
  if (!userId) {
    // Not an error and not a refusal to be logged loudly: an App installed on
    // an organisation delivers every repository's events, and most of them are
    // not enrolled here.
    increment("github_pr_not_enrolled");
    return "not-enrolled";
  }

  const where = { owner_repo_number: { ...key(repo.owner, repo.repo), number: pull.number } };
  const existing = await prisma.pullRequestWorkspace.findUnique({ where });

  // A redelivery of an event already acted on. The delivery-id claim catches
  // exact repeats; this catches the other shape — GitHub sending `synchronize`
  // for a push that did not move the head this server has not already built.
  if (existing && existing.headSha === pull.headSha) return "unchanged";

  if (existing) {
    await prisma.pullRequestWorkspace.update({
      where,
      data: { headSha: pull.headSha, headRef: pull.headRef },
    });

    const deployment = await publish(existing.projectId);
    const url = siteUrl(deployment.subdomain);
    const commentId = await comment(
      userId,
      repo.owner,
      repo.repo,
      pull.number,
      existing.commentId,
      commentBody(url, pull.headSha),
    );
    if (commentId !== existing.commentId) {
      await prisma.pullRequestWorkspace.update({ where, data: { commentId } });
    }

    increment("github_pr_refreshed");
    return "refreshed";
  }

  // `getRepo` first, because `importRepository` needs what GitHub says about
  // the repository — its size above all, which is how a repository too big for
  // this server's quota is refused before anything is downloaded.
  const token = await githubToken(userId);
  const descriptor = await getRepo(token, repo.owner, repo.repo);

  const project = await importRepository(userId, {
    owner: repo.owner,
    repo: repo.repo,
    ref: pull.headRef,
    name: `${repo.repo}-pr-${String(pull.number)}`,
  }, descriptor);

  // §13.4's group. The row for 13.4 predicted that it and 13.3 "want the same
  // object", and this is where that turns out to be true: a pull request
  // workspace IS a second checkout of one repository, so it joins the group and
  // gets the shared environment rather than being another unrelated project.
  await joinGroup(project.id, userId, repo.owner, repo.repo);

  await prisma.pullRequestWorkspace.create({
    data: {
      ...key(repo.owner, repo.repo),
      number: pull.number,
      headRef: pull.headRef,
      headSha: pull.headSha,
      projectId: project.id,
    },
  });

  const deployment = await publish(project.id);
  const url = siteUrl(deployment.subdomain);
  const commentId = await comment(
    userId,
    repo.owner,
    repo.repo,
    pull.number,
    null,
    commentBody(url, pull.headSha),
  );
  if (commentId) {
    await prisma.pullRequestWorkspace.update({ where, data: { commentId } });
  }

  increment("github_pr_created");
  return "created";
}

/** Merged or closed: give the memory and the disk back. */
async function teardown(
  repo: { owner: string; repo: string },
  number: number,
): Promise<Outcome> {
  const where = { owner_repo_number: { ...key(repo.owner, repo.repo), number } };
  const row = await prisma.pullRequestWorkspace.findUnique({
    where,
    select: { projectId: true, project: { select: { ownerId: true } } },
  });
  if (!row) return "ignored";

  // The TRASH rather than a purge, deliberately. `trashProjectService` removes
  // the container, stops the managed database and takes the deployment offline
  // — which is all of the cost — while leaving seven days in which somebody who
  // merged by mistake still has the workspace. Decision 13's shape again: the
  // guarantee is that the expensive things are stopped, not that the row is
  // gone.
  await trashProjectService(row.projectId, row.project.ownerId);

  // The row goes even though the project is only trashed: this pull request is
  // finished, and reopening it should build a fresh workspace rather than
  // resurrect one whose branch has moved on.
  await prisma.pullRequestWorkspace.delete({ where });

  increment("github_pr_torn_down");
  return "torn-down";
}

/** A push to a branch that some open pull request is from.
 *
 *  **This is the trigger §12.2 says in its own text that it lacks.** That row
 *  shipped prebuilds and states what is missing is a policy for *when* — "build
 *  on push, or build on a schedule, or build when a devcontainer.json changes".
 *  This is the first of the three, and it arrives with a reason attached rather
 *  than a schedule somebody guessed.
 */
async function rebuild(
  repo: { owner: string; repo: string },
  branch: string,
  sha: string,
): Promise<Outcome> {
  const row = await prisma.pullRequestWorkspace.findFirst({
    where: { ...key(repo.owner, repo.repo), headRef: branch },
  });
  // A push to a branch with no pull request open is not this feature's
  // business. GitHub sends `push` beside `pull_request` for the same commit, so
  // this is the common case rather than the odd one.
  if (!row) return "ignored";

  return upsert(repo, {
    number: row.number,
    headRef: branch,
    headSha: sha,
    title: `#${String(row.number)}`,
  });
}

export async function applyDecision(decision: WebhookDecision): Promise<Outcome> {
  switch (decision.kind) {
    case "ping":
      return "ping";
    case "ignore":
      logger.debug("ignored a GitHub delivery", { why: decision.why });
      return "ignored";
    case "upsert":
      return upsert(decision.repo, decision.pull);
    case "teardown":
      return teardown(decision.repo, decision.number);
    case "rebuild":
      return rebuild(decision.repo, decision.branch, decision.sha);
  }
}
