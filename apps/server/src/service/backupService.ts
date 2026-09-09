import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { prisma } from "../lib/prisma.js";
import { assertValidProjectId, isLocalProject, projectRoot } from "../utils/projectPaths.js";

/** Backups, for the failure nothing else here survives. plan.md §3.3, §14.2.
 *
 *  **What was missing.** Everything a user has lived in exactly one place: the
 *  working tree on the host's disk, the rows in one Postgres. Nothing copied
 *  either anywhere else, ever. That made it the only open row in the roadmap
 *  that LOSES data rather than failing to add a feature, which is why §14
 *  puts it ahead of everything that does add one.
 *
 *  **What already existed and does not solve it**, recorded because both get
 *  mistaken for this: per-file checkpoints are on the same disk as the tree
 *  they snapshot, and `GET /:projectId/export` is a manual, per-project,
 *  user-initiated zip. A backup is the one that runs when nobody remembers to.
 *  The trash (§9.1) answers "I meant the other project"; this answers "the
 *  host died", and only the second needs a destination.
 *
 *  **The destination is configuration, not code.** §3.3 filed this as blocked
 *  on a deployment decision, and §9's method says to ask which half needs a
 *  person: the person picks a directory, this writes files to it. A second
 *  disk, an NFS mount, an rclone mount in front of a bucket, or a path
 *  something else rsyncs off the host are all the same to this module, and
 *  choosing between them is a decision it has no information to make.
 *
 *  **Three deliberate departures from what a copy does**, each of which
 *  somebody would otherwise "fix" by reusing the shared constant:
 *
 *  1. **`.git` is INCLUDED.** `EXCLUDED_DIRECTORIES` drops it, correctly, for
 *     duplicates and exports — a copy does not want somebody else's history.
 *     A backup is the opposite case: the history IS the work, and a restore
 *     that hands back a tree with no commits has lost most of what was there.
 *  2. **A project whose tree is a folder on the host (§10.2) has its ROW
 *     backed up and not its tree.** That tree is somewhere the operator
 *     already manages, and copying arbitrary host paths into a backup
 *     destination is a surprise nobody asked for. The manifest records the
 *     path and that it was skipped, so a restore can say what it did not
 *     restore rather than quietly producing an empty project.
 *  3. **Trashed projects are backed up.** They are restorable until they are
 *     purged (§9.1), so a backup that skipped them would make the trash a
 *     place work goes to become unrecoverable.
 */

/** The layout version written into every manifest.
 *
 *  A restore refuses a version it does not know rather than guessing. The one
 *  thing worse than no backup is a restore that half-works.
 */
export const BACKUP_FORMAT = 1;

/** Directories left out of a backup.
 *
 *  Not `EXCLUDED_DIRECTORIES` — see the note above about `.git`. Everything
 *  here is reproducible from a manifest that IS backed up, and between them
 *  they are usually most of a tree's bytes.
 */
export const BACKUP_EXCLUDED_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
] as const;

export interface BackupManifest {
  format: number;
  projectId: string;
  at: number;
  /** sha256 of `tree.tar.gz`, so a restore can tell a truncated archive from a
   *  complete one. A backup nobody can verify is a backup nobody should
   *  trust. */
  treeSha256: string | null;
  treeBytes: number;
  /** The project's `updatedAt` at the moment it was copied.
   *
   *  What the next sweep compares against, and it is deliberately NOT `at`.
   *  Comparing a project's `updatedAt` to the wall-clock time the last backup
   *  RAN answers "has it changed since then" only while both clocks agree: a
   *  server clock that steps forward — an NTP correction, a restored VM, a
   *  container starting with a skewed clock — makes every project look
   *  unchanged and silently stops backing anything up, which is this feature's
   *  worst failure and the one nothing would report. Comparing two values of
   *  the same column cannot skew.
   */
  sourceUpdatedAt: number;
  /** Set when the tree was deliberately not copied, with the reason. */
  treeSkipped?: { reason: string; path?: string };
  /** What the database half carried, so a restore can report it before doing
   *  anything rather than after. */
  rows: { collaborators: number; scheduledJobs: number; databaseConnections: number };
}

export interface BackupSummary {
  backedUp: number;
  skipped: number;
  failed: number;
  pruned: number;
}

/** Whether backups are configured at all. */
export function backupsEnabled(): boolean {
  return env.BACKUP_DIR.trim().length > 0;
}

/** Where one project's backups live. */
function projectBackupRoot(projectId: string): string {
  return path.join(env.BACKUP_DIR, assertValidProjectId(projectId));
}

/** Refuses a destination that cannot answer the question this exists for.
 *
 *  A backup inside `PROJECTS_DIR` — or holding it — is on the same disk as the
 *  thing it backs up, and "the host died" takes both. Checked at boot rather
 *  than at the first sweep, because a deployment that has been backing up to
 *  the wrong place for a month is a deployment with no backups and a false
 *  sense of having some.
 */
export function assertBackupDestination(): void {
  if (!backupsEnabled()) return;

  const destination = path.resolve(env.BACKUP_DIR);
  const projects = path.resolve(env.PROJECTS_DIR);

  const inside = (child: string, parent: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  if (inside(destination, projects) || inside(projects, destination)) {
    throw new Error(
      `BACKUP_DIR (${destination}) is on the same tree as PROJECTS_DIR ` +
        `(${projects}). A backup there is lost with the disk it protects ` +
        `against losing. Point it at a separate disk or mount.`,
    );
  }
}

/** The rows that are meaningless without the project, and are not rebuildable.
 *
 *  Deliberately narrower than "everything that references a project".
 *  Deployments and releases are excluded because they describe build output
 *  and containers that do not exist after a host loss anyway — a restore
 *  republishes rather than resurrects. Reports, moderation actions and
 *  notifications are excluded because they are the operator's record of a
 *  conversation, not the user's work.
 *
 *  Environment variables need no line here: they are a column on the project
 *  row, and they are SEALED. A restore onto a deployment with a different
 *  `SECRET_ENCRYPTION_KEY` gets rows it cannot read, which is documented
 *  rather than defended against — the alternative is writing them in the
 *  clear into an archive.
 */
async function readProjectRows(projectId: string) {
  const [project, collaborators, scheduledJobs, databaseConnections] =
    await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      prisma.projectCollaborator.findMany({ where: { projectId } }),
      prisma.scheduledJob.findMany({ where: { projectId } }),
      prisma.projectDatabaseConnection.findMany({ where: { projectId } }),
    ]);

  return { project, collaborators, scheduledJobs, databaseConnections };
}

/** Archives a directory to a file, and returns its size and digest.
 *
 *  Written to a temporary name and renamed on success, because a half-written
 *  archive that carries a plausible name is worse than a missing one: the
 *  pruner would count it, and a restore would find it and fail partway.
 */
async function archiveTree(
  source: string,
  destination: string,
): Promise<{ bytes: number; sha256: string }> {
  const temporary = `${destination}.partial`;

  const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });
  const out = createWriteStream(temporary);

  archive.on("warning", (error: Error) => {
    // A file that vanished mid-walk is not a failed backup; anything else is
    // reported and the archive still finishes.
    logger.warn("backup archive warning", { source, reason: error.message });
  });

  archive.glob("**/*", {
    cwd: source,
    dot: true,
    ignore: [...BACKUP_EXCLUDED_GLOBS],
  });

  const finished = pipeline(archive, out);
  await archive.finalize();
  await finished;

  // Digested from the file rather than from the stream on the way past, so
  // what is hashed is what actually landed on disk — which is the only thing a
  // restore can check against.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(temporary)) {
    hash.update(chunk as Buffer);
  }

  const { size } = await fs.stat(temporary);
  await fs.rename(temporary, destination);

  return { bytes: size, sha256: hash.digest("hex") };
}

/** Backs one project up. Returns the manifest, or null when nothing was due. */
export async function backupProject(
  projectId: string,
  options: { force?: boolean } = {},
): Promise<BackupManifest | null> {
  assertValidProjectId(projectId);

  const rows = await readProjectRows(projectId);
  if (!rows.project) return null;

  const at = Date.now();
  const root = projectBackupRoot(projectId);

  // Nothing has happened since the last one. Skipped rather than re-archived:
  // a nightly sweep over a hundred idle projects is otherwise a gzip of every
  // one of them, every night, producing seven identical copies.
  const updatedAt = rows.project.updatedAt.getTime();

  if (!options.force) {
    const previous = (await listBackups(projectId)).at(-1);
    if (previous !== undefined && updatedAt <= previous.sourceUpdatedAt) {
      return null;
    }
  }

  const directory = path.join(root, String(at));
  await fs.mkdir(directory, { recursive: true });

  let treeSha256: string | null = null;
  let treeBytes = 0;
  let treeSkipped: BackupManifest["treeSkipped"];

  if (isLocalProject(projectId)) {
    // §10.2's folders. The row is ours; the tree is not.
    treeSkipped = {
      reason:
        "This project is a folder already on the host, opened rather than " +
        "created here. Its files are not copied — back that path up the way " +
        "you back up the rest of that disk.",
      path: projectRoot(projectId),
    };
  } else {
    const source = projectRoot(projectId);
    const exists = await fs
      .stat(source)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (!exists) {
      // A row with no tree. Two of these are on record (§3.4) and deleting
      // rows is somebody else's judgment call, so the backup says so and
      // carries the row anyway.
      treeSkipped = { reason: "This project has no working tree on disk." };
    } else {
      const archived = await archiveTree(source, path.join(directory, "tree.tar.gz"));
      treeBytes = archived.bytes;
      treeSha256 = archived.sha256;
    }
  }

  await fs.writeFile(
    path.join(directory, "project.json"),
    JSON.stringify(rows, null, 2),
    "utf8",
  );

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    projectId,
    at,
    treeSha256,
    treeBytes,
    sourceUpdatedAt: updatedAt,
    ...(treeSkipped ? { treeSkipped } : {}),
    rows: {
      collaborators: rows.collaborators.length,
      scheduledJobs: rows.scheduledJobs.length,
      databaseConnections: rows.databaseConnections.length,
    },
  };

  // Last, and it is the completion marker: `listBackups` only counts a
  // directory holding one. A sweep killed halfway through leaves a directory
  // with an archive and no manifest, which is ignored and overwritten rather
  // than restored from.
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  return manifest;
}

/** Every complete backup of one project, oldest first. */
export async function listBackups(projectId: string): Promise<BackupManifest[]> {
  const root = projectBackupRoot(projectId);

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const manifests: BackupManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const raw = await fs
      .readFile(path.join(root, entry.name, "manifest.json"), "utf8")
      .catch(() => null);
    if (raw === null) continue;

    try {
      manifests.push(JSON.parse(raw) as BackupManifest);
    } catch {
      // A manifest that will not parse is not a backup. Left on disk for
      // somebody to look at rather than deleted.
      logger.warn("unreadable backup manifest", { projectId, at: entry.name });
    }
  }

  return manifests.sort((a, b) => a.at - b.at);
}

/** Drops the oldest backups of one project beyond `BACKUP_KEEP`. */
export async function pruneBackups(projectId: string): Promise<number> {
  const backups = await listBackups(projectId);
  const excess = backups.length - env.BACKUP_KEEP;
  if (excess <= 0) return 0;

  const root = projectBackupRoot(projectId);
  let pruned = 0;

  for (const backup of backups.slice(0, excess)) {
    await fs
      .rm(path.join(root, String(backup.at)), { recursive: true, force: true })
      .then(() => {
        pruned += 1;
      })
      .catch((error: unknown) => {
        logger.warn("could not prune a backup", {
          projectId,
          at: backup.at,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return pruned;
}

/** The last sweep's outcome, for the operator screen.
 *
 *  In memory, and deliberately: it is a fact about this process, and a
 *  restarted server that reported the previous process's backup as its own
 *  would be reporting something it has not done.
 */
let lastRun: {
  at: number;
  ok: boolean;
  summary?: BackupSummary;
  error?: string;
} | null = null;

export function backupStatus(): {
  enabled: boolean;
  destination: string | null;
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  backedUp: number | null;
} {
  return {
    enabled: backupsEnabled(),
    destination: backupsEnabled() ? env.BACKUP_DIR : null,
    lastRunAt: lastRun?.at ?? null,
    lastRunOk: lastRun?.ok ?? null,
    lastError: lastRun?.error ?? null,
    backedUp: lastRun?.summary?.backedUp ?? null,
  };
}

/** Backs up every project that has changed since its last backup.
 *
 *  One project failing does not stop the sweep. That is the whole difference
 *  between a backup system and a script: the run where one tree is unreadable
 *  is exactly the run where the other ninety-nine matter most.
 */
export async function runBackupSweep(): Promise<BackupSummary> {
  const summary: BackupSummary = { backedUp: 0, skipped: 0, failed: 0, pruned: 0 };

  if (!backupsEnabled()) return summary;

  const projects = await prisma.project.findMany({ select: { id: true } });

  for (const { id } of projects) {
    try {
      const manifest = await backupProject(id);
      if (manifest === null) {
        summary.skipped += 1;
      } else {
        summary.backedUp += 1;
        increment("backups_completed");
      }

      summary.pruned += await pruneBackups(id);
    } catch (error) {
      summary.failed += 1;
      increment("backups_failed");
      logger.error("could not back a project up", error, { projectId: id });
    }
  }

  lastRun = {
    at: Date.now(),
    // A sweep in which anything failed is not a successful sweep. Reporting it
    // green because most of it worked is how a backup system becomes a thing
    // nobody checks.
    ok: summary.failed === 0,
    summary,
    ...(summary.failed > 0
      ? { error: `${String(summary.failed)} project(s) could not be backed up` }
      : {}),
  };

  logger.info("backup sweep finished", { ...summary });
  return summary;
}

/** For tests, which must not inherit a previous case's run. */
export function resetBackupStatusForTest(): void {
  lastRun = null;
}
