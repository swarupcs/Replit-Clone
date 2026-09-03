import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../utils/errors.js";
import { isLocalProject, projectRoot } from "../utils/projectPaths.js";
import { increment } from "../lib/metrics.js";
import { resolveProjectEntitlements } from "./entitlementService.js";

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
  /** The limit is passed in rather than read from `env`, because it is the
   *  owner's plan that decides it and this error is what says so. */
  constructor(usedBytes: number, limitMb: number) {
    super(
      507,
      "QUOTA_EXCEEDED",
      `This project has reached its ${String(limitMb)} MB limit ` +
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

/** Current usage, from cache when it is fresh enough.
 *
 *  Zero for a folder somebody opened, and that is not a shortcut. This number
 *  exists to ration a shared VM's disk between tenants; a local folder's bytes
 *  are on a disk this platform neither provided nor can free -- deleting the
 *  project would leave every one of them exactly where it is. Counting them
 *  would make an editor refuse to save into its user's own free space, which
 *  is the failure §10.4 is about, arriving one item early.
 *
 *  Zero rather than "skip the check at each call site" so that there is one
 *  answer in one place: everything downstream compares a number, and the
 *  honest number for space this platform does not own is none of it.
 */
export async function usedBytes(projectId: string): Promise<number> {
  if (isLocalProject(projectId)) return 0;

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
  // See `usedBytes`: this quota is about space this platform allocates, and a
  // folder somebody opened is space it does not. Returning early rather than
  // relying on a zero total, so the entitlement lookup is skipped too.
  if (isLocalProject(projectId)) return;

  const used = await usedBytes(projectId);
  const projected = used - replacingBytes + incomingBytes;

  // The owner's plan, not the deployment's constant: a collaborator writing
  // into someone else's project spends the owner's allowance, which is the
  // rule the user-level quota already followed.
  const { projectDiskQuotaMb } = await resolveProjectEntitlements(projectId);

  if (projected > projectDiskQuotaMb * 1024 * 1024) {
    increment("quota_rejections");
    throw new QuotaExceededError(used, projectDiskQuotaMb);
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
