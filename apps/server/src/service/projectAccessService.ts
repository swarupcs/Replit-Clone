import { randomBytes } from "node:crypto";
import { pageRequest, toPage, type Page, type PublicProject } from "@replit-clone/shared";
import type { Project } from "../generated/prisma/client.js";
import { ProjectRole, ProjectVisibility } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

/** Who may do what to a project.
 *
 *  Ownership used to be a single `ownerId` compared for equality, so a project
 *  could be used by exactly one person and there was no way to show it to
 *  anybody. Access is now a level, and every operation states the level it
 *  needs rather than assuming the caller is the owner.
 */

/** Ordered, so a check is a comparison rather than a list of equality tests.
 *
 *  `visitor` sits BELOW `viewer`, and that placement is the whole security
 *  design of public projects. Every existing check in this codebase asks for
 *  `viewer` or higher, so introducing a level underneath it opens nothing:
 *  each of those checks refuses a visitor until somebody deliberately lowers
 *  it. Making PUBLIC grant `viewer` instead would have silently handed
 *  strangers the project's database query editor (`databaseController` is
 *  viewer-level throughout) and its git history including remote URLs. Neither
 *  is what a person means when they make a project public.
 */
const RANK: Record<AccessLevel, number> = {
  none: 0,
  visitor: 1,
  viewer: 2,
  editor: 3,
  owner: 4,
};

/** What a caller may do with a project.
 *
 *  - `visitor` — the project is public. Read its files, take a copy. Nothing
 *    else: no preview (which would start a container for a stranger), no
 *    database, no git, no collaborator list, no environment variables.
 *  - `viewer` — a named, invited reader. Everything a visitor may do, plus the
 *    things that assume the owner chose to trust this particular person.
 *  - `editor` — may write and run.
 *  - `owner` — may also share, publish, rename and delete.
 */
export type AccessLevel = "none" | "visitor" | "viewer" | "editor" | "owner";

export interface ProjectAccess {
  project: Project;
  level: AccessLevel;
}

function levelFromRole(role: ProjectRole): AccessLevel {
  return role === ProjectRole.EDITOR ? "editor" : "viewer";
}

/** A project as the dashboard list returns it.
 *
 *  Deliberately not `Project`. See the select in `listAccessibleProjects`.
 */
export interface ListedProject {
  id: string;
  name: string;
  template: string;
  ownerId: string;
  createdAt: Date;
  lastActiveAt: Date | null;
  visibility: ProjectVisibility;
  forkedFromId: string | null;
  takenDownAt: Date | null;
}

/** What this user may do with this project. */
export async function getProjectAccess(
  projectId: string,
  userId: string,
): Promise<ProjectAccess | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      collaborators: { where: { userId }, select: { role: true } },
    },
  });

  if (!project) return null;

  // A project in the trash is gone as far as every caller of this function is
  // concerned, which is nearly the whole product: routes, socket handlers, the
  // editor, the terminal, the deploy panel. `assertProjectAccess` turns null
  // into a 404, which is also the honest answer -- the owner deleted it.
  //
  // Restoring deliberately does not come through here. It is the one operation
  // that has to see past this line, so it looks the row up itself and says so.
  if (project.deletedAt) return null;

  if (project.ownerId === userId) return { project, level: "owner" };

  const collaborator = project.collaborators[0];
  if (collaborator) return { project, level: levelFromRole(collaborator.role) };

  // Last, so an invitation always wins over the public grant. Someone invited
  // as an editor to a project that later became public must keep their editor
  // access, not be demoted to what any stranger gets.
  if (project.visibility === ProjectVisibility.PUBLIC) {
    return { project, level: "visitor" };
  }

  return { project, level: "none" };
}

/** Makes a project readable by anybody signed in, or private again.
 *
 *  Owner only, and no other side effects. In particular this does NOT touch
 *  the share token, the collaborator list, or the environment variables:
 *  publishing is a decision about who may read the source, and quietly
 *  revoking someone's invitation because of it would be the platform making a
 *  second decision the owner did not ask for.
 */
export async function setProjectVisibility(
  projectId: string,
  ownerId: string,
  visibility: ProjectVisibility,
): Promise<Project> {
  await assertProjectAccess(projectId, ownerId, "owner");

  // Everything above this line is about the owner's own decision. A takedown
  // is somebody else's, and it used to be expressed in the same column -- so
  // the person it was applied to could reverse it here, in one request.
  //
  // Only re-publishing is refused. Going private is still theirs: a moderator
  // wanting it non-public cannot object, and refusing would make the failure
  // mode of this check "you may not make your own project more private".
  if (visibility === ProjectVisibility.PUBLIC) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { takenDownAt: true },
    });

    if (project?.takenDownAt) {
      throw new ForbiddenError(
        "A moderator made this project private after a report. You cannot " +
          "publish it again.",
        "TAKEN_DOWN",
      );
    }
  }

  return prisma.project.update({
    where: { id: projectId },
    data: { visibility },
  });
}

/** The gallery: public projects, newest first.
 *
 *  Returns a deliberately narrow shape rather than the row. A `Project` carries
 *  `envVars` and `shareToken`, and this list is readable by anybody with an
 *  account -- so the columns are named explicitly here, where forgetting one is
 *  a compile error, instead of being stripped by a caller who might not.
 */
export async function listPublicProjects(
  page: { cursor?: string; limit?: number } = {},
): Promise<Page<PublicProject>> {
  const { cursor, limit } = pageRequest(page);

  const rows = await prisma.project.findMany({
    where: { visibility: ProjectVisibility.PUBLIC, deletedAt: null },
    select: {
      id: true,
      name: true,
      template: true,
      createdAt: true,
      owner: { select: { email: true } },
      _count: { select: { forks: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const { items, nextCursor } = toPage(rows, limit);

  return {
    nextCursor,
    items: items.map((row) => ({
      id: row.id,
      name: row.name,
      template: row.template,
      createdAt: row.createdAt.toISOString(),
    // The local part only. A gallery is a public page and the whole address is
    // more than it needs to say who made something.
    //
    // The owner is a required relation, so `row.owner` is not supposed to be
    // null -- but an account being deleted cascades its projects, and a read
    // that lands in the middle of that can observe the row without it. The
    // fallback below already existed for a missing name; without the optional
    // access a null owner throws past it and takes the whole gallery down for
    // everybody, which is a poor trade for one project mid-deletion.
      ownerName: row.owner?.email.split("@")[0] ?? "someone",
      forks: row._count.forks,
    })),
  };
}

/** Asserts at least `required`, or reports the project as missing.
 *
 *  A project the caller cannot reach is reported as 404 rather than 403, so the
 *  endpoint cannot be used to discover which ids exist — the same reasoning the
 *  original ownership check used.
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string,
  required: AccessLevel = "editor",
): Promise<Project> {
  const access = await getProjectAccess(projectId, userId);

  if (!access || access.level === "none") {
    throw new NotFoundError("Project not found");
  }

  if (RANK[access.level] < RANK[required]) {
    // Here the caller demonstrably knows the project exists — they can see it
    // — so saying "not allowed" tells them nothing they did not already know.
    throw new ForbiddenError(
      required === "owner"
        ? "Only the project's owner can do that"
        : "You have read-only access to this project",
      "INSUFFICIENT_ACCESS",
    );
  }

  return access.project;
}

/** Every project a user can open, theirs and shared with them alike.
 *
 *  The one list here that had no cap at all, so a user with five hundred
 *  projects got five hundred rows in one payload and one unbounded scan.
 *
 *  Paged like the rest, and the dashboard reads **every** page rather than
 *  offering a "load more" -- deliberately, and it is the reason this is not a
 *  UI change. That screen filters and sorts the whole set in the browser, so a
 *  page break there would mean searching for a project and being told it does
 *  not exist because it is on page two. This bounds the query; it does not
 *  change what the screen is for, which is everything you can open.
 */
export async function listAccessibleProjects(
  userId: string,
  page: { cursor?: string; limit?: number } = {},
): Promise<Page<ListedProject>> {
  const { cursor, limit } = pageRequest(page);

  const rows = await prisma.project.findMany({
    where: {
      OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
      // The dashboard lists what you can open. The trash is its own screen,
      // asked for by name, so a deleted project cannot be opened from the
      // list it no longer appears in.
      deletedAt: null,
    },
    // This query had no order either, which a cursor cannot be built on: the
    // database was free to answer in a different order each time, and a page
    // boundary in an unstable order drops rows silently.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    // Named explicitly, for the reason spelled out on `listPublicProjects`
    // twenty lines below -- which this function did not follow. A `Project`
    // row carries `shareToken`, and returning the row handed every viewer of
    // every shared project a bearer credential that redeems at the link's
    // role: a read-only collaborator could hand out access the owner never
    // offered. It also carries `envVars`, whose values are sealed but whose
    // NAMES are not, and 2.14 already settled that read-only access to a
    // project is not access to its secrets.
    select: {
      id: true,
      name: true,
      template: true,
      ownerId: true,
      createdAt: true,
      lastActiveAt: true,
      visibility: true,
      forkedFromId: true,
      // The owner has to be able to see that this happened, and the dashboard
      // is where they look. Not a secret: it is a fact about them.
      takenDownAt: true,
    },
  });

  return toPage(rows, limit);
}

/** Adds or updates a collaborator, by email. */
export async function setCollaborator(
  projectId: string,
  ownerId: string,
  email: string,
  role: ProjectRole,
): Promise<{ userId: string; email: string; role: ProjectRole }> {
  const project = await assertProjectAccess(projectId, ownerId, "owner");

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new NotFoundError("No account with that email", "NO_SUCH_USER");
  }

  if (user.id === project.ownerId) {
    throw new ForbiddenError(
      "The owner already has full access",
      "OWNER_NOT_COLLABORATOR",
    );
  }

  await prisma.projectCollaborator.upsert({
    where: { projectId_userId: { projectId, userId: user.id } },
    create: { projectId, userId: user.id, role },
    update: { role },
  });

  return { userId: user.id, email: user.email, role };
}

export async function removeCollaborator(
  projectId: string,
  ownerId: string,
  userId: string,
): Promise<void> {
  await assertProjectAccess(projectId, ownerId, "owner");

  await prisma.projectCollaborator.deleteMany({ where: { projectId, userId } });
}

export async function listCollaborators(
  projectId: string,
  userId: string,
): Promise<{ userId: string; email: string; role: ProjectRole }[]> {
  await assertProjectAccess(projectId, userId, "viewer");

  const rows = await prisma.projectCollaborator.findMany({
    where: { projectId },
    include: { user: { select: { id: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    userId: row.user.id,
    email: row.user.email,
    role: row.role,
  }));
}

/** Creates, or replaces, the project's share link secret.
 *
 *  Replacing rather than reusing means "create a new link" also revokes every
 *  link handed out before it, which is the behaviour someone reaches for when
 *  a link has gone somewhere it should not have.
 *
 *  `role` is what the NEXT holder of the link gets; an EDITOR link is still a
 *  named grant — redeeming adds the signed-in user as a collaborator the owner
 *  can see and demote, never an anonymous write credential.
 */
export async function rotateShareToken(
  projectId: string,
  ownerId: string,
  role: ProjectRole = ProjectRole.VIEWER,
): Promise<string> {
  await assertProjectAccess(projectId, ownerId, "owner");

  // 32 bytes: this is a bearer credential in a URL, so it has to be
  // unguessable rather than merely unique.
  const token = randomBytes(32).toString("base64url");

  await prisma.project.update({
    where: { id: projectId },
    data: { shareToken: token, shareRole: role },
  });

  return token;
}

export async function revokeShareToken(
  projectId: string,
  ownerId: string,
): Promise<void> {
  await assertProjectAccess(projectId, ownerId, "owner");
  await clearShareToken(projectId);
}

/** The same, with no access check, for a caller that is not the owner.
 *
 *  Moderation's teardown. Its counterpart on the embed is `revokeEmbed`, which
 *  a takedown has called since 2.16 -- and a share token is the same kind of
 *  object: a bearer string that was pasted somewhere. Only one of the two was
 *  closed. This is the cleanup half; the clause in `redeemShareToken` is the
 *  half that is a guarantee (6, decision 13).
 */
export async function clearShareToken(projectId: string): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { shareToken: null },
  });
}

/** Redeems a share link: adds the holder as a collaborator at the link's role.
 *
 *  Redeeming rather than granting access to the link itself, so access survives
 *  the link being revoked, and so the owner can see who actually has it.
 */
export async function redeemShareToken(
  token: string,
  userId: string,
): Promise<Project> {
  // `takenDownAt` is in the WHERE, not checked afterwards, for the reason 6
  // decision 13 gives: the token is also cleared when a moderator acts, but
  // that is a write which can fail, and a takedown that depends on a
  // successful cleanup is a takedown that usually works. A project taken down
  // for SECRETS must stop handing its source to whoever holds the link, and
  // one taken down for MALWARE must stop handing them a container to run it
  // in -- neither of which redeeming was refusing.
  const project = await prisma.project.findFirst({
    where: { shareToken: token, takenDownAt: null, deletedAt: null },
  });

  // Deliberately the same sentence a revoked link gets. Somebody holding a
  // link is not owed the news that a project was moderated, and telling them
  // would make the link a way to ask.
  if (!project) throw new NotFoundError("That share link is no longer valid");

  if (project.ownerId === userId) return project;

  await prisma.projectCollaborator.upsert({
    where: { projectId_userId: { projectId: project.id, userId } },
    create: { projectId: project.id, userId, role: project.shareRole },
    // An existing collaborator keeps whatever they already have: a viewer link
    // must not silently demote someone who was given edit access directly.
    update: {},
  });

  return project;
}

export { ProjectRole, ProjectVisibility };
