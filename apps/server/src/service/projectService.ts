import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import {
  assertProjectAccess as assertAccess,
  getProjectAccess,
} from "./projectAccessService.js";
import { claimForSandbox, projectRoot } from "../utils/projectPaths.js";
import {
  DEFAULT_TEMPLATE_ID,
  getTemplate,
  TEMPLATE_FILES_ROOT,
} from "../templates/registry.js";
import {
  removeCacheVolume,
  removeContainer,
} from "../containers/containerManager.js";
import {
  destroy as destroyManagedDatabase,
  provision as provisionManagedDatabase,
} from "./managedDatabaseService.js";
import { forgetProject as forgetCheckpoints } from "./checkpointService.js";
import { forgetRun } from "../containers/runner.js";
import { forgetDevcontainer } from "../containers/devcontainer.js";
import { forgetUsage } from "./diskUsageService.js";
import { forgetProject as forgetCollab } from "./collabService.js";
import {
  assertCanCreateProject,
  forgetUserQuota,
} from "./userQuotaService.js";
import { unpublish } from "./deployService.js";
import { ForbiddenError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";

export function projectDir(projectId: string): string {
  return projectRoot(projectId);
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
  });
}

/** Re-exported so every existing caller keeps working while the check itself
 *  became role-aware. See projectAccessService for what the levels mean. */
export { assertProjectAccess } from "./projectAccessService.js";

export async function createProjectService(
  ownerId: string,
  name?: string,
  templateId: string = DEFAULT_TEMPLATE_ID,
): Promise<Project> {
  const template = getTemplate(templateId);

  // Before the row is written, so a refusal leaves nothing behind.
  await assertCanCreateProject(ownerId);

  const project = await prisma.project.create({
    data: {
      name: name?.trim() || template.label,
      ownerId,
      template: template.id,
    },
  });

  const dir = projectDir(project.id);

  try {
    await fs.mkdir(dir, { recursive: true });

    // Copy committed starter files rather than shelling out to `npm create`
    // on the HOST. That call ran an arbitrary configured command outside any
    // sandbox, needed the network, and produced a nested `sandbox/` directory
    // so the bind-mount root and the app root disagreed by one level.
    await fs.cp(path.join(TEMPLATE_FILES_ROOT, template.filesDir), dir, {
      recursive: true,
    });

    // The container runs as the sandbox user, not as the server. Without this
    // the bind mount is read-only to it and `npm install` fails with EACCES.
    // Best-effort: when the server is not root this cannot succeed, and
    // `containerUser` matches the container to the directory instead.
    await claimForSandbox(dir).catch(() => {});

    // A template that names a database gets one. Provisioning here rather
    // than at first run means DATABASE_URL exists before the container is
    // ever built, so the migration in the start command has something to
    // talk to on the very first open.
    if (template.database) {
      await provisionManagedDatabase(project.id);
    }
  } catch (error) {
    // Never leave a DB row pointing at a directory that was not scaffolded.
    await destroyManagedDatabase(project.id).catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return project;
}

export async function deleteProjectService(
  projectId: string,
  userId: string,
): Promise<void> {
  // Owner only: a collaborator losing the project for everyone is not a
  // mistake worth making recoverable, because it is not recoverable.
  await assertAccess(projectId, userId, "owner");

  await removeContainer(projectId);
  // The database container AND its volume. A volume outliving the row that
  // pointed at it is the mistake `deployService.unpublish` learned about
  // published files, with rather more disk attached to it.
  await destroyManagedDatabase(projectId).catch(() => undefined);
  // Snapshots must not outlive what they are snapshots of.
  await forgetCheckpoints(projectId).catch(() => undefined);
  // The cache volume outlives a restart deliberately, but not the project.
  await removeCacheVolume(projectId);
  // Before the row goes: the cascade would take the deployment record with it
  // and leave the published FILES behind, still being served to the public
  // from an address nothing in the database points at any more.
  await unpublish(projectId).catch((error: unknown) => {
    logger.error("could not take the deployment offline", error);
  });
  // Otherwise a recreated project with the same id would inherit stale run
  // state and a log from the deleted one.
  forgetRun(projectId);
  // So a recreated project with the same id does not inherit the deleted one's
  // devcontainer warnings and lifecycle log.
  forgetDevcontainer(projectId);
  forgetUsage(projectId);
  forgetCollab(projectId);
  forgetUserQuota(projectId, userId);
  await prisma.project.delete({ where: { id: projectId } });
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

export async function touchProject(projectId: string): Promise<void> {
  await prisma.project
    .update({ where: { id: projectId }, data: { lastActiveAt: new Date() } })
    .catch(() => {
      // A socket for a deleted project is not worth failing the request over.
    });
}

/** Renames a project. The directory is keyed by id, so only the row changes. */
export async function renameProjectService(
  projectId: string,
  userId: string,
  name: string,
): Promise<Project> {
  await assertAccess(projectId, userId, "owner");

  return prisma.project.update({
    where: { id: projectId },
    data: { name: name.trim() },
  });
}

/** Refuses to make a second copy of a project a moderator took down.
 *
 *  The takedown is enforced by three queries filtering on `takenDownAt`, and a
 *  guard that lives on a column is only as good as the operations that cannot
 *  produce a row without it. Both of the ones below can: they build a fresh
 *  `Project` from the source's template and files -- the files being the thing
 *  that was reported -- and the new row's column is null, so the copy may be
 *  published, deployed, embedded and scheduled exactly as the original may not.
 *
 *  Refused rather than sanitised. Copying `takenDownAt` across would have this
 *  platform moderate a project nobody reported, and in the fork case against
 *  somebody moderation never acted on. Saying no names the reason and leaves
 *  the appeal as the route back, which is what it is for.
 */
function assertNotTakenDown(source: Project): void {
  if (!source.takenDownAt) return;

  throw new ForbiddenError(
    "A moderator took this project down after a report. It cannot be copied " +
      "while that stands.",
    "TAKEN_DOWN",
  );
}

/** Copies a project's files into a brand new project.
 *
 *  Dependencies are deliberately not copied: `node_modules` is the bulk of a
 *  project's bytes, is reproducible from the manifest, and copying it would
 *  make a duplicate slower than a fresh install.
 *
 *  Environment variables come along **only for an editor or the owner**, and
 *  that condition is the whole of the difference between a convenience and a
 *  credential leak. Reading `/env` requires editor access, on the stated
 *  grounds that read-only access to a project is not access to its secrets —
 *  so a viewer who could copy them here would be reading, through a duplicate
 *  they own, exactly what that endpoint refuses them. A copy that cannot run
 *  is not much of a copy, but a copy that launders somebody else's
 *  credentials is worse.
 */
export async function duplicateProjectService(
  projectId: string,
  userId: string,
  name?: string,
): Promise<Project> {
  // A viewer may take a copy — the copy is theirs, and they could have done it
  // by hand from the file tree anyway. It still counts against their own quota.
  const source = await assertAccess(projectId, userId, "viewer");
  assertNotTakenDown(source);
  await assertCanCreateProject(userId);

  // Re-read rather than infer from the level `assertAccess` was given: it was
  // asked for "viewer or better" and answers only that it was satisfied.
  const access = await getProjectAccess(projectId, userId);
  const trustedWithSecrets =
    access?.level === "editor" || access?.level === "owner";

  const copy = await prisma.project.create({
    data: {
      name: name?.trim() || `${source.name} copy`,
      ownerId: userId,
      template: source.template,
      envVars: trustedWithSecrets ? (source.envVars ?? {}) : {},
    },
  });

  try {
    await copyProjectFiles(projectId, copy.id);
  } catch (error) {
    await prisma.project.delete({ where: { id: copy.id } }).catch(() => {});
    await fs
      .rm(projectDir(copy.id), { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }

  return copy;
}

/** Takes a copy of somebody else's public project.
 *
 *  The near-neighbour of `duplicateProjectService`, and the two differences
 *  are the entire feature:
 *
 *  1. **It is allowed at `visitor`.** Forking a stranger's project without
 *     asking anybody is what makes a gallery or a shared tutorial link work at
 *     all; requiring an invitation first is the thing that stops it being a
 *     social mechanic.
 *  2. **The environment variables do NOT come along.** A duplicate keeps them
 *     because the project was already yours and they were already your
 *     secrets. A fork is a stranger's copy of somebody else's work, and
 *     copying an API key into it -- silently, on a button press, into a
 *     project the original owner cannot see or delete -- would be handing out
 *     credentials as a feature. The fork starts with none and says so.
 *
 *  What travels: the files, the template, and the start command. Not the git
 *  history (a remote URL can carry a token, and `.git` is excluded from every
 *  copy here anyway), not the collaborators, not the share link, not the
 *  database, not the deployment. A fork is the code, and nothing that was
 *  arranged around it.
 */
export async function forkProjectService(
  projectId: string,
  userId: string,
  name?: string,
): Promise<Project> {
  const source = await assertAccess(projectId, userId, "visitor");
  assertNotTakenDown(source);

  // Their own quota, like any project they create. A fork is cheap to ask for
  // and exactly as expensive to host as anything else.
  await assertCanCreateProject(userId);

  const fork = await prisma.project.create({
    data: {
      name: name?.trim() || source.name,
      ownerId: userId,
      template: source.template,
      startCommand: source.startCommand,
      // Provenance, not ownership: deleting the original leaves this null and
      // the fork untouched.
      forkedFromId: source.id,
      // Never inherited. A copy of a public project starts private, whatever
      // the original was -- publishing is a decision, and making it on
      // somebody's behalf because they pressed Fork is not one they made.
      visibility: "PRIVATE",
      // Empty, deliberately. See the note above: this is the line between a
      // fork and a credential leak.
      envVars: {},
    },
  });

  try {
    await copyProjectFiles(projectId, fork.id);
  } catch (error) {
    await prisma.project.delete({ where: { id: fork.id } }).catch(() => {});
    await fs
      .rm(projectDir(fork.id), { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }

  return fork;
}

/** The file half of a duplicate or a fork.
 *
 *  Shared so the two cannot drift on what they exclude -- which matters most
 *  for `.git`, whose absence is what keeps a remote URL (and any token in it)
 *  out of a stranger's copy.
 */
async function copyProjectFiles(
  sourceProjectId: string,
  targetProjectId: string,
): Promise<void> {
  const destination = projectDir(targetProjectId);
  const sourceRoot = projectDir(sourceProjectId);

  await fs.mkdir(destination, { recursive: true });
  await fs.cp(sourceRoot, destination, {
    recursive: true,
    filter: (entrySource) => !excludedFromCopy(sourceRoot, entrySource),
  });
  await claimForSandbox(destination).catch(() => {});
}

/** Directories a copy or an export has no business carrying.
 *
 *  Dependencies and build output are reproducible from the manifest and are
 *  most of a project's bytes, so carrying them would make a duplicate slower
 *  than a fresh install and an export far larger than it needs to be.
 */
export const EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
] as const;

/** Matches a path segment naming one of the excluded directories. */
const EXCLUDED_SEGMENT = new RegExp(
  `(^|[\\\\/])(${EXCLUDED_DIRECTORIES.map((name) =>
    name.replace(/\./g, "\\."),
  ).join("|")})([\\\\/]|$)`,
);

/** Whether `fs.cp` should skip this entry.
 *
 *  Tested against the path INSIDE the project, not the absolute one `fs.cp`
 *  hands over. Matching the whole path meant the prefix counted too, so a
 *  PROJECTS_DIR containing a segment named `dist`, `build` or `.git` filtered
 *  the copy's own root and produced an empty project with no error at all.
 */
function excludedFromCopy(sourceRoot: string, entrySource: string): boolean {
  const relative = path.relative(sourceRoot, entrySource);

  // The root itself is never excluded; excluding it copies nothing.
  if (relative === "") return false;

  return EXCLUDED_SEGMENT.test(relative);
}

/** For archiver's glob, which takes patterns. Derived from the same list so
 *  the two cannot drift apart. */
export const EXCLUDED_GLOBS = EXCLUDED_DIRECTORIES.map(
  (name) => `**/${name}/**`,
);
