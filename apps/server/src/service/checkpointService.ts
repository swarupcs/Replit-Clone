import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { projectRoot } from "../utils/projectPaths.js";

/** Where a project's checkpoints live.
 *
 *  Beside the project tree rather than inside it — under the project root a
 *  snapshot directory would be committed, exported, walked by the file
 *  panel, and counted against the project's own disk quota. The same
 *  reasoning that keeps env vars out of a file in the tree.
 */
function checkpointRoot(projectId: string): string {
  return path.join(projectRoot(projectId), "..", `.checkpoints-${projectId}`);
}

/** How many versions of one file are kept.
 *
 *  Replit can recover a file from before the first commit; without this an
 *  uncommitted mistake is simply gone. A window rather than a
 *  history: this is an "undo that survives a reload", not version control,
 *  and git is the thing that already does the other job. */
const KEEP_PER_FILE = 20;

/** Minimum gap between two checkpoints of the same file.
 *
 *  Writes are debounced to roughly every keystroke pause, so snapshotting
 *  every one would keep twenty versions covering the last forty seconds —
 *  useless for the case this exists for, which is noticing an hour later
 *  that something was deleted. */
const MIN_INTERVAL_MS = 60_000;

/** A path safe to use as a filename, and reversible enough to explain.
 *
 *  A hash rather than an escaped path: paths nest arbitrarily deep, and a
 *  scheme that encodes separators produces names long enough to hit the
 *  filesystem's own limit on a deep tree. */
function fileKey(relPath: string): string {
  return createHash("sha256").update(relPath).digest("hex").slice(0, 24);
}

export interface Checkpoint {
  /** Milliseconds since the epoch, and the filename. */
  at: number;
  bytes: number;
}

const lastSnapshot = new Map<string, number>();

/** Records a version of a file, if enough time has passed since the last.
 *
 *  Never throws: a checkpoint that cannot be written must not fail the save
 *  it was taken from. Losing a snapshot is a small loss; losing the write is
 *  the user's actual work.
 */
export async function snapshot(
  projectId: string,
  relPath: string,
  contents: string,
): Promise<void> {
  if (!env.CHECKPOINTS_ENABLED) return;

  const key = `${projectId}:${relPath}`;
  const now = Date.now();
  const previous = lastSnapshot.get(key) ?? 0;
  if (now - previous < MIN_INTERVAL_MS) return;

  lastSnapshot.set(key, now);

  try {
    const dir = path.join(checkpointRoot(projectId), fileKey(relPath));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${String(now)}`), contents, "utf8");

    // The name is written beside the snapshots so a checkpoint can be listed
    // for a path without reversing the hash, which is not possible.
    await fs.writeFile(path.join(dir, "path"), relPath, "utf8");

    await prune(dir);
  } catch (error) {
    logger.warn("could not write a checkpoint", {
      projectId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function prune(dir: string): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => []);
  const snapshots = entries
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(b) - Number(a));

  for (const stale of snapshots.slice(KEEP_PER_FILE)) {
    await fs.rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

export async function listCheckpoints(
  projectId: string,
  relPath: string,
): Promise<Checkpoint[]> {
  const dir = path.join(checkpointRoot(projectId), fileKey(relPath));
  const entries = await fs.readdir(dir).catch(() => []);

  const checkpoints: Checkpoint[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await fs.stat(path.join(dir, name)).catch(() => undefined);
    if (stat) checkpoints.push({ at: Number(name), bytes: stat.size });
  }

  // Newest first: the one somebody wants is almost always the most recent.
  return checkpoints.sort((a, b) => b.at - a.at);
}

export async function readCheckpoint(
  projectId: string,
  relPath: string,
  at: number,
): Promise<string | null> {
  const dir = path.join(checkpointRoot(projectId), fileKey(relPath));
  // `at` comes from the client, so it is validated as a number rather than
  // interpolated: a path separator in it would escape the directory.
  if (!Number.isSafeInteger(at) || at <= 0) return null;

  return fs
    .readFile(path.join(dir, String(at)), "utf8")
    .catch(() => null);
}

/** Removes every checkpoint for a project. Called when the project is
 *  deleted, so snapshots do not outlive what they were snapshots of. */
export async function forgetProject(projectId: string): Promise<void> {
  await fs
    .rm(checkpointRoot(projectId), { recursive: true, force: true })
    .catch(() => undefined);

  for (const key of [...lastSnapshot.keys()]) {
    if (key.startsWith(`${projectId}:`)) lastSnapshot.delete(key);
  }
}

/** For tests: forgets the debounce state without touching disk. */
export function resetSnapshotClock(): void {
  lastSnapshot.clear();
}
