import { randomBytes } from "node:crypto";
import type { Project } from "../generated/prisma/client.js";
import { ProjectRole } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";

/** Who may do what to a project.
 *
 *  Ownership used to be a single `ownerId` compared for equality, so a project
 *  could be used by exactly one person and there was no way to show it to
 *  anybody. Access is now a level, and every operation states the level it
 *  needs rather than assuming the caller is the owner.
 */

/** Ordered, so a check is a comparison rather than a list of equality tests. */
const RANK: Record<AccessLevel, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
};

export type AccessLevel = "none" | "viewer" | "editor" | "owner";

export interface ProjectAccess {
  project: Project;
  level: AccessLevel;
}

function levelFromRole(role: ProjectRole): AccessLevel {
  return role === ProjectRole.EDITOR ? "editor" : "viewer";
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

  if (project.ownerId === userId) return { project, level: "owner" };

  const collaborator = project.collaborators[0];
  if (collaborator) return { project, level: levelFromRole(collaborator.role) };

  return { project, level: "none" };
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

/** Every project a user can open, theirs and shared with them alike. */
export async function listAccessibleProjects(userId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: {
      OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
    },
    orderBy: { createdAt: "desc" },
  });
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
  const project = await prisma.project.findUnique({ where: { shareToken: token } });

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

export { ProjectRole };
