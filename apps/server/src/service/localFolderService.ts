import path from "node:path";
import type { Project } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  loadLocalRoots,
  registerLocalRoot,
} from "../utils/projectPaths.js";
import {
  listLocalFolders,
  localFolderRoots,
  localFoldersEnabled,
  resolveLocalFolder,
} from "../utils/localRoots.js";
import {
  detectPackageManager,
  detectStartCommand,
  detectTemplate,
  inspectDirectory,
} from "./repoImportService.js";
import { assertCanCreateProject } from "./userQuotaService.js";
import { BadRequestError } from "../utils/errors.js";

/** Opening a folder that is already on the disk.
 *
 *  Every other way into this editor creates the tree first: a template is
 *  copied, or a repository is cloned. Both leave a directory this server made,
 *  owns, and may do anything to. This one starts from a directory that was
 *  already there, which is the only route that matters when the editor is
 *  somebody's own -- and it inverts the ownership assumption that four other
 *  parts of this codebase were written under.
 *
 *  What it deliberately does NOT do, and each is a decision rather than an
 *  omission:
 *
 *  - **It does not copy.** A copy would be a second source of truth for files
 *    the person is also editing in their own tools, and the first divergence
 *    would be silent. The bind mount is the point.
 *  - **It does not chown.** `createProjectService` hands its tree to the
 *    sandbox uid because it made that tree; doing it to somebody's source
 *    directory would take their own files away from them. `containerUser`
 *    already falls back to the directory's real owner, which for a folder the
 *    operator opened is exactly the right answer.
 *  - **It does not scaffold.** No template files are written into it. The
 *    template is DETECTED, and only to decide which image can run it.
 */

export interface LocalFolderOptions {
  /** What to call it. Defaults to the folder's own name, which is nearly
   *  always what somebody would have typed. */
  name?: string;
}

/** What this deployment will let somebody open, for the screen that offers it. */
export function localFolderSettings(): {
  enabled: boolean;
  roots: string[];
} {
  return { enabled: localFoldersEnabled(), roots: localFolderRoots() };
}

/** Subdirectories of an allowed folder, so a folder can be chosen by walking
 *  rather than by typing a path exactly right. */
export async function browseLocalFolders(
  parent: string,
): Promise<{ path: string; name: string }[]> {
  return listLocalFolders(parent);
}

/** Opens a folder as a project.
 *
 *  Idempotent on the path, and that is the useful behaviour rather than a
 *  convenience: `localPath` is unique because two rows over one directory means
 *  two containers writing one tree with no arbiter. So opening a folder that is
 *  already open returns the project it is already open as -- for its owner. For
 *  anybody else it is a refusal, because handing somebody an existing project
 *  by guessing a path would be an access-control hole wearing a helpful
 *  message.
 */
export async function openLocalFolderService(
  ownerId: string,
  candidate: string,
  options: LocalFolderOptions = {},
): Promise<Project> {
  const root = await resolveLocalFolder(candidate);

  const existing = await prisma.project.findUnique({
    where: { localPath: root },
  });

  if (existing) {
    // Deliberately the same message for "somebody else has it open" and "it is
    // in somebody's trash": both are true, neither is this caller's business,
    // and distinguishing them would report on another account's projects.
    if (existing.ownerId !== ownerId || existing.deletedAt) {
      throw new BadRequestError(
        "That folder is already open as another project",
        "FOLDER_ALREADY_OPEN",
      );
    }
    return existing;
  }

  // Before the row, so a refusal leaves nothing behind. The project COUNT is
  // still a real limit for a local folder -- what stops applying is the disk,
  // which is not this platform's to ration. See `isLocalProject`'s callers.
  await assertCanCreateProject(ownerId);

  const { files, packageJson } = await inspectDirectory(root);
  const template = detectTemplate(files, packageJson);
  // A folder somebody already had is MORE likely to be pnpm or yarn than a
  // fresh clone is -- it is somebody's real working tree, with whatever they
  // chose years ago -- so getting this wrong here is worse, not better.
  const startCommand = detectStartCommand(packageJson, detectPackageManager(files));

  const project = await prisma.project.create({
    data: {
      name: options.name?.trim() || path.basename(root) || "folder",
      ownerId,
      template,
      localPath: root,
      startCommand,
    },
  });

  // Together with the row rather than after it: until this runs, `projectRoot`
  // reports the server-owned path for this id, and anything that resolved a
  // path in between would be confined to the wrong directory. Nothing can
  // reach the project before its id is returned, and this is inside that gap.
  registerLocalRoot(project.id, root);

  logger.info("opened a local folder as a project", {
    projectId: project.id,
    template,
  });

  return project;
}

/** Seeds the path registry at boot.
 *
 *  Must run before the server accepts anything: a request that resolves a path
 *  for a local project before its root is registered would be confined to
 *  `PROJECTS_ROOT/<id>` -- a directory that does not exist -- and the project
 *  would look empty rather than broken, which is the worse of the two.
 */
export async function loadLocalFolders(): Promise<void> {
  const rows = await prisma.project.findMany({
    where: { localPath: { not: null } },
    select: { id: true, localPath: true },
  });

  await loadLocalRoots(rows);

  if (rows.length > 0) {
    logger.info("registered local folder projects", { count: rows.length });
  }
}
