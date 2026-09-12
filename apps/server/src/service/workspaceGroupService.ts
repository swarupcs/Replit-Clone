import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import {
  type EnvVars,
  envVarsSchema,
  parseEnvVars,
  sealEnvVars,
} from "./projectEnvService.js";

/** Several checkouts of one repository that know they are related. §13.4.
 *
 *  The row's complaint is that the second checkout is *unrelated*: its own
 *  container, its own env vars, its own entry on the dashboard, and no way to
 *  tell it apart from a project that merely happens to share a name. The group
 *  is what makes it related — one repository identity, one shared environment,
 *  one entry with the checkouts under it.
 *
 *  **The row's own parenthetical is stale, and the motivation survives it.** It
 *  says reviewing a colleague's branch means stashing, "and §10.13 records that
 *  stash does not exist". §10.13 shipped, so it does. But stashing still means
 *  putting your work down to pick up somebody else's, and `switchBranch`
 *  refuses outright on a dirty worktree — two checkouts is the thing that lets
 *  you keep both.
 */

/** GitHub's naming rules, applied before the value becomes a key. */
const NAME = /^[A-Za-z0-9._-]+$/;

function assertNameable(value: string, what: string): void {
  if (!NAME.test(value) || value.startsWith("-") || value.length > 100) {
    throw new BadRequestError(`That ${what} is not a valid GitHub name.`, "BAD_REPO");
  }
}

/** Lower-cased everywhere, for the reason §13.3's rows give: a case-sensitive
 *  key opens a second group for the same repository the first time somebody
 *  types the name differently. */
function key(owner: string, repo: string): { owner: string; repo: string } {
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/** Finds the group for a repository on this account, creating it on first use.
 *
 *  Creating on demand rather than making somebody create one first: a group
 *  with no second checkout in it is not a thing anybody wants to manage, and
 *  the moment it becomes useful is the moment a second checkout appears.
 */
export async function groupFor(
  userId: string,
  rawOwner: string,
  rawRepo: string,
): Promise<{ id: string; owner: string; repo: string }> {
  assertNameable(rawOwner, "owner");
  assertNameable(rawRepo, "repository");
  const where = key(rawOwner, rawRepo);

  const row = await prisma.workspaceGroup.upsert({
    where: { userId_owner_repo: { userId, ...where } },
    create: { userId, ...where },
    update: {},
    select: { id: true, owner: true, repo: true },
  });

  return row;
}

/** Puts an existing project into the group for a repository.
 *
 *  Separate from creating the project on purpose: §13.3's pull request
 *  workspaces are created by a webhook and this is how they join, and an
 *  ordinary import joins the same way. The row predicted 13.3 and 13.4 "want
 *  the same object"; this is the seam where that turns out to be true.
 */
export async function joinGroup(
  projectId: string,
  userId: string,
  owner: string,
  repo: string,
): Promise<void> {
  const group = await groupFor(userId, owner, repo);
  await prisma.project.update({ where: { id: projectId }, data: { groupId: group.id } });
}

/** The environment every checkout of this repository shares, for showing it.
 *
 *  `getEnvVars` does NOT call this — it has its own reader, because this file
 *  imports `sealEnvVars` and `parseEnvVars` from `projectEnvService` and
 *  importing back would make a cycle. Two readers of one column is the sort of
 *  thing that drifts, so both go through `parseEnvVars` and neither unseals by
 *  hand.
 */
export async function groupEnvVars(groupId: string | null): Promise<EnvVars> {
  if (!groupId) return {};

  const row = await prisma.workspaceGroup.findUnique({
    where: { id: groupId },
    select: { envVars: true },
  });

  return parseEnvVars(row?.envVars);
}

export async function setGroupEnvVars(
  groupId: string,
  userId: string,
  vars: unknown,
): Promise<EnvVars> {
  const parsed = envVarsSchema.safeParse(vars);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
      "INVALID_ENV_VARS",
    );
  }

  // The userId is in the WHERE rather than checked after a read: somebody
  // else's group cannot be written by guessing its id.
  const { count } = await prisma.workspaceGroup.updateMany({
    where: { id: groupId, userId },
    data: { envVars: sealEnvVars(parsed.data) },
  });
  if (count === 0) throw new NotFoundError("No such workspace group.", "GROUP_NOT_FOUND");

  // The plaintext the caller sent, exactly as `setEnvVars` does: they are
  // entitled to it and they just typed it.
  return parsed.data;
}

export interface GroupedWorkspaces {
  id: string;
  owner: string;
  repo: string;
  checkouts: { id: string; name: string; groupId: string | null }[];
}

/** One entry per repository, with its checkouts under it — the third thing the
 *  row asks for, after shared credentials and shared env vars.
 *
 *  Returns groups only. A project that is nobody's second checkout is not a
 *  group of one here; it stays an ordinary row in the ordinary list, which is
 *  what it is.
 */
export async function listGroups(userId: string): Promise<GroupedWorkspaces[]> {
  const rows = await prisma.workspaceGroup.findMany({
    where: { userId },
    select: {
      id: true,
      owner: true,
      repo: true,
      projects: {
        where: { deletedAt: null },
        select: { id: true, name: true, groupId: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    checkouts: row.projects,
  }));
}

/** The other checkouts of the same repository as this project. */
export async function siblingsOf(projectId: string): Promise<Project[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { groupId: true },
  });
  if (!project?.groupId) return [];

  return prisma.project.findMany({
    where: { groupId: project.groupId, deletedAt: null, id: { not: projectId } },
    orderBy: { createdAt: "asc" },
  });
}
