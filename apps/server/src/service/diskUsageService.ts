import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { projectRoot } from "../utils/projectPaths.js";
import { increment } from "../lib/metrics.js";

/** Per-project storage accounting.
 *
 *  Containers are capped on memory, CPU and PIDs, but nothing bounded what a
 *  project could write. The project directory is a bind mount of a real host
 *  path, so a socket writing in a loop — or one runaway install — could fill
 *  the VM's disk and take Postgres and every other project with it.
 *
 *  Walking the tree costs real IO, so the result is cached and only recomputed
 *  once it is stale. The cache tracks its own writes exactly and re-measures
 *  periodically to pick up whatever the container did behind our back.
 */

const QUOTA_BYTES = env.PROJECT_DISK_QUOTA_MB * 1024 * 1024;

/** How long a measurement is trusted before the tree is walked again. */
const CACHE_TTL_MS = 30_000;

/** Directories excluded from the walk, matching the file tree's own ignores.
 *  Dependencies are the bulk of a project's bytes, so they are counted — this
 *  is only about not descending into their internals twice. */
const SKIP_TRAVERSAL = new Set([".git"]);

interface Measurement {
  bytes: number;
  measuredAt: number;
}

const cache = new Map<string, Measurement>();

export class QuotaExceededError extends AppError {
  constructor(usedBytes: number) {
    super(
      507,
      "QUOTA_EXCEEDED",
      `This project has reached its ${String(env.PROJECT_DISK_QUOTA_MB)} MB limit ` +
        `(${(usedBytes / 1024 / 1024).toFixed(1)} MB used). Delete some files and try again.`,
    );
  }
}

/** Sums the bytes on disk beneath a directory. */
async function measure(target: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    // A directory that vanished mid-walk contributes nothing.
    return 0;
  }

  let total = 0;

  for (const entry of entries) {
    const child = path.join(target, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_TRAVERSAL.has(entry.name)) continue;
      total += await measure(child);
      continue;
    }

    // `lstat`, so a symlink is counted as the link it is rather than pulling in
    // the size of something outside the project.
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const stats = await fs.lstat(child).catch(() => undefined);
    // Blocks, not `size`: a sparse file's apparent size is not what it costs.
    if (stats) total += stats.blocks * 512;
  }

  return total;
}

/** Current usage, from cache when it is fresh enough. */
export async function usedBytes(projectId: string): Promise<number> {
  const cached = cache.get(projectId);
  if (cached && Date.now() - cached.measuredAt < CACHE_TTL_MS) {
    return cached.bytes;
  }

  const bytes = await measure(projectRoot(projectId));
  cache.set(projectId, { bytes, measuredAt: Date.now() });
  return bytes;
}

/** Throws unless `incomingBytes` more would still fit.
 *
 *  `replacingBytes` is what the write is about to overwrite, so saving a file
 *  that shrinks is never refused for being over quota.
 */
export async function assertWithinQuota(
  projectId: string,
  incomingBytes: number,
  replacingBytes = 0,
): Promise<void> {
  const used = await usedBytes(projectId);
  const projected = used - replacingBytes + incomingBytes;

  if (projected > QUOTA_BYTES) {
    increment("quota_rejections");
    throw new QuotaExceededError(used);
  }
}

/** Records a write against the cached total, so a burst of them is bounded
 *  without re-walking the tree for each one. */
export function recordWrite(
  projectId: string,
  incomingBytes: number,
  replacingBytes: number,
): void {
  const cached = cache.get(projectId);
  if (!cached) return;

  cached.bytes = Math.max(0, cached.bytes - replacingBytes + incomingBytes);
}

/** Drops a project's measurement, e.g. once it is deleted. */
export function forgetUsage(projectId: string): void {
  cache.delete(projectId);
}
