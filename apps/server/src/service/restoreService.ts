import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import {
  assertValidProjectId,
  claimProjectForSandbox,
  projectRoot,
} from "../utils/projectPaths.js";
import {
  BACKUP_FORMAT,
  listBackups,
  type BackupManifest,
} from "./backupService.js";

/** Reading a backup back. plan.md §3.3, §14.2.
 *
 *  In a module of its own rather than beside `backupService`, because the two
 *  run in different worlds: the backup runs on a healthy host on a timer, and
 *  this runs by hand on a host where something has gone wrong. Keeping the
 *  read path free of the sweep's scheduling, metrics and pruning is what makes
 *  it possible to reason about at the moment somebody actually needs it.
 *
 *  **The rule this module is built around: never destroy anything to restore
 *  something.** A restore is reached for at the worst moment, usually by
 *  somebody guessing, and a restore that silently overwrote a tree would be a
 *  second data-loss bug shipped inside the fix for the first. So an existing
 *  tree is refused unless the caller says otherwise in as many words, and even
 *  then it is moved aside rather than deleted.
 */

export interface RestorePlan {
  manifest: BackupManifest;
  /** Where the tree would land. */
  target: string;
  /** Whether something is already there. */
  targetExists: boolean;
  /** Whether the row is already in the database. */
  rowExists: boolean;
  /** Anything the caller should know before saying yes. */
  warnings: string[];
}

export interface RestoreResult {
  projectId: string;
  at: number;
  treeRestored: boolean;
  filesWritten: number;
  rowRestored: boolean;
  /** Where an existing tree was moved to, when one was replaced. */
  displaced: string | null;
  warnings: string[];
}

function backupDirectory(projectId: string, at: number): string {
  return path.join(env.BACKUP_DIR, assertValidProjectId(projectId), String(at));
}

/** The backup that would be used: the newest, or the one asked for. */
export async function resolveBackup(
  projectId: string,
  at?: number,
): Promise<BackupManifest> {
  const backups = await listBackups(projectId);
  if (backups.length === 0) {
    throw new Error(`No backups found for ${projectId} under ${env.BACKUP_DIR}`);
  }

  if (at === undefined) {
    // `listBackups` is oldest first, so the newest is the last one.
    const newest = backups.at(-1);
    if (!newest) throw new Error(`No backups found for ${projectId}`);
    return newest;
  }

  const found = backups.find((backup) => backup.at === at);
  if (!found) {
    throw new Error(
      `No backup of ${projectId} at ${String(at)}. Available: ` +
        backups.map((backup) => String(backup.at)).join(", "),
    );
  }
  return found;
}

/** Verifies an archive against the digest recorded when it was written.
 *
 *  The reason a manifest carries one at all. Without this, a truncated archive
 *  — a disk that filled during the sweep, a mount that dropped, a copy that
 *  was interrupted — is discovered by restoring it, which is the worst
 *  possible moment and often destroys the evidence.
 */
export async function verifyBackup(
  projectId: string,
  at: number,
): Promise<{ ok: boolean; reason?: string }> {
  const manifest = await readManifest(projectId, at);

  if (manifest.treeSha256 === null) {
    // Nothing was archived — a local folder, or a row with no tree. Both are
    // recorded in the manifest and neither is a corrupt backup.
    return { ok: true };
  }

  const archive = path.join(backupDirectory(projectId, at), "tree.tar.gz");

  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(archive)) {
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${archive}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const actual = hash.digest("hex");
  if (actual !== manifest.treeSha256) {
    return {
      ok: false,
      reason: `digest mismatch: manifest says ${manifest.treeSha256}, archive is ${actual}`,
    };
  }

  return { ok: true };
}

async function readManifest(
  projectId: string,
  at: number,
): Promise<BackupManifest> {
  const file = path.join(backupDirectory(projectId, at), "manifest.json");
  const raw = await fs.readFile(file, "utf8");
  const manifest = JSON.parse(raw) as BackupManifest;

  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(
      `Backup ${projectId}/${String(at)} is format ${String(manifest.format)}; ` +
        `this server reads format ${String(BACKUP_FORMAT)}. Refusing rather ` +
        `than guessing at a layout it does not know.`,
    );
  }

  return manifest;
}

/** What a restore would do, without doing any of it.
 *
 *  Separate from `restoreProject` on purpose: the person running this is
 *  usually doing so for the first time, on a bad day, and being able to read
 *  the consequences before consenting to them is most of what makes a restore
 *  something anybody is willing to run.
 */
export async function planRestore(
  projectId: string,
  at?: number,
): Promise<RestorePlan> {
  const manifest = await resolveBackup(projectId, at);
  const target = projectRoot(projectId);

  const [targetExists, existingRow, verification] = await Promise.all([
    fs
      .stat(target)
      .then((stat) => stat.isDirectory())
      .catch(() => false),
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }),
    verifyBackup(projectId, manifest.at),
  ]);

  const warnings: string[] = [];

  if (!verification.ok) {
    warnings.push(`The archive does not verify — ${verification.reason ?? "unknown"}.`);
  }

  if (manifest.treeSkipped) {
    warnings.push(`No tree in this backup: ${manifest.treeSkipped.reason}`);
  }

  if (targetExists) {
    warnings.push(
      `${target} already exists. It will be moved aside, not deleted, and ` +
        `only if you pass --force.`,
    );
  }

  if (existingRow) {
    warnings.push(
      `A project row for ${projectId} is already in the database. Its fields ` +
        `will be overwritten from the backup.`,
    );
  }

  // Said even when nothing is wrong, because the failure it describes is
  // silent: sealed values restore fine and decrypt to nothing.
  warnings.push(
    "Environment variables are sealed with SECRET_ENCRYPTION_KEY. Restoring " +
      "onto a deployment with a different key restores rows that cannot be " +
      "read.",
  );

  return {
    manifest,
    target,
    targetExists,
    rowExists: existingRow !== null,
    warnings,
  };
}

/** Unpacks a tar.gz into a directory, refusing any entry that escapes it.
 *
 *  The archive is this server's own output, which is exactly the reasoning
 *  that makes path traversal in unpackers so common. It is a FILE ON DISK by
 *  the time it gets here, in a directory an operator pointed at, and the
 *  confinement rule this codebase applies to every client path applies for the
 *  same reason: the check costs nothing and its absence is only discovered by
 *  somebody exploiting it.
 */
async function unpack(
  archive: string,
  destination: string,
): Promise<{ files: number }> {
  const root = path.resolve(destination);
  const extract = tar.extract();
  let files = 0;

  extract.on("entry", (header, stream, next) => {
    void (async () => {
      try {
        const resolved = path.resolve(root, header.name);
        const relative = path.relative(root, resolved);

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`archive entry escapes the target: ${header.name}`);
        }

        if (header.type === "directory") {
          await fs.mkdir(resolved, { recursive: true });
          stream.resume();
        } else if (header.type === "file") {
          await fs.mkdir(path.dirname(resolved), { recursive: true });

          // The mode from the archive, not the process umask. Without this a
          // restored `./deploy.sh` comes back without its execute bit and the
          // project is subtly broken in a way that looks like the script
          // itself being wrong.
          const handle = await fs.open(resolved, "w", header.mode);
          await pipeline(stream, handle.createWriteStream());
          files += 1;
        } else {
          // Symlinks and the rest. A backup of a project tree has no business
          // carrying them into a restore, and following one is how an unpack
          // writes outside its root.
          logger.warn("skipping a non-file archive entry", {
            name: header.name,
            type: header.type,
          });
          stream.resume();
        }

        next();
      } catch (error) {
        extract.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  await pipeline(createReadStream(archive), createGunzip(), extract);

  return { files };
}

/** Puts a project back.
 *
 *  Order matters and is deliberate: **the tree first, then the row.** A row
 *  pointing at a tree that is not there is a project the dashboard lists and
 *  nothing can open; a tree with no row is invisible and harmless, and the
 *  next run puts it right.
 */
export async function restoreProject(
  projectId: string,
  options: { at?: number; force?: boolean; skipVerify?: boolean } = {},
): Promise<RestoreResult> {
  assertValidProjectId(projectId);

  const manifest = await resolveBackup(projectId, options.at);
  const directory = backupDirectory(projectId, manifest.at);
  const warnings: string[] = [];

  if (!options.skipVerify) {
    const verification = await verifyBackup(projectId, manifest.at);
    if (!verification.ok) {
      throw new Error(
        `Refusing to restore a backup that does not verify: ` +
          `${verification.reason ?? "unknown"}. Pass --skip-verify to restore ` +
          `it anyway, knowing it is damaged.`,
      );
    }
  }

  const target = projectRoot(projectId);
  let displaced: string | null = null;
  let treeRestored = false;
  let filesWritten = 0;

  if (manifest.treeSkipped) {
    warnings.push(`No tree restored: ${manifest.treeSkipped.reason}`);
    if (manifest.treeSkipped.path) {
      warnings.push(`Its files were at ${manifest.treeSkipped.path}.`);
    }
  } else {
    const exists = await fs
      .stat(target)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (exists) {
      if (!options.force) {
        throw new Error(
          `${target} already exists. Restoring would replace a working tree ` +
            `that is on this disk right now. Pass --force to move it aside ` +
            `and restore over it.`,
        );
      }

      // Moved, never deleted. If the restore turns out to be the wrong
      // backup — which is the ordinary case when somebody is guessing — the
      // thing they replaced is still there.
      displaced = `${target}.displaced-${String(Date.now())}`;
      await fs.rename(target, displaced);
      warnings.push(`The tree that was there has been moved to ${displaced}.`);
    }

    await fs.mkdir(target, { recursive: true });
    const unpacked = await unpack(path.join(directory, "tree.tar.gz"), target);
    filesWritten = unpacked.files;
    treeRestored = true;

    // Everything just written belongs to whoever ran this command, which on a
    // fresh host is root. The sandbox runs as uid 1001 and bind-mounts this
    // tree, so without this the project opens, lists its files, and fails
    // every write with EACCES — a restore that looks like it worked.
    await claimProjectForSandbox(projectId).catch((error: unknown) => {
      warnings.push(
        `Could not hand ${target} to the sandbox user: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The project may open read-only.`,
      );
    });
  }

  const raw = await fs.readFile(path.join(directory, "project.json"), "utf8");
  const rows = JSON.parse(raw) as {
    project: Record<string, unknown> | null;
    collaborators: Record<string, unknown>[];
    scheduledJobs: Record<string, unknown>[];
    databaseConnections: Record<string, unknown>[];
  };

  let rowRestored = false;

  if (rows.project) {
    const owner = await prisma.user.findUnique({
      where: { id: rows.project["ownerId"] as string },
      select: { id: true },
    });

    if (!owner) {
      // Restoring a project onto an account that does not exist would create a
      // row nobody can reach. Said plainly rather than failing on a foreign
      // key three frames down.
      warnings.push(
        `Owner ${String(rows.project["ownerId"])} does not exist on this ` +
          `server, so the project row was NOT restored. The files are in ` +
          `${target}. Create that account, or import the tree as a new project.`,
      );
    } else {
      await restoreRows(rows);
      rowRestored = true;
    }
  }

  logger.info("project restored", {
    projectId,
    at: manifest.at,
    treeRestored,
    filesWritten,
    rowRestored,
  });

  return {
    projectId,
    at: manifest.at,
    treeRestored,
    filesWritten,
    rowRestored,
    displaced,
    warnings,
  };
}

/** Writes the row and its relations back, in one transaction.
 *
 *  All or nothing, because the half-states are worse than the absence: a
 *  project with its collaborators but not its scheduled jobs looks complete
 *  and is not, and nothing afterwards would ever notice.
 */
async function restoreRows(rows: {
  project: Record<string, unknown> | null;
  collaborators: Record<string, unknown>[];
  scheduledJobs: Record<string, unknown>[];
  databaseConnections: Record<string, unknown>[];
}): Promise<void> {
  const project = rows.project;
  if (!project) return;

  const id = project["id"] as string;

  await prisma.$transaction(async (tx) => {
    // Dates come back from JSON as strings and Prisma will not coerce them.
    const revived = reviveDates(project);

    await tx.project.upsert({
      where: { id },
      create: revived as never,
      update: revived as never,
    });

    // Replaced rather than merged. A restore says "this is what the project
    // was", and leaving a collaborator who was added after the backup would
    // make the result neither the backup nor the present state.
    await tx.projectCollaborator.deleteMany({ where: { projectId: id } });
    await tx.scheduledJob.deleteMany({ where: { projectId: id } });
    await tx.projectDatabaseConnection.deleteMany({ where: { projectId: id } });

    for (const row of rows.collaborators) {
      await tx.projectCollaborator.create({ data: reviveDates(row) as never });
    }
    for (const row of rows.scheduledJobs) {
      await tx.scheduledJob.create({ data: reviveDates(row) as never });
    }
    for (const row of rows.databaseConnections) {
      await tx.projectDatabaseConnection.create({ data: reviveDates(row) as never });
    }
  });
}

/** ISO date strings back into Dates.
 *
 *  `JSON.stringify` turns every `Date` into a string and nothing turns them
 *  back, so a restore without this fails on the first date column with a type
 *  error that names neither the column nor the reason.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function reviveDates(row: Record<string, unknown>): Record<string, unknown> {
  const revived: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    revived[key] =
      typeof value === "string" && ISO_DATE.test(value) ? new Date(value) : value;
  }

  return revived;
}
