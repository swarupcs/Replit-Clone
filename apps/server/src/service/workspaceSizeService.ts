import Docker from "dockerode";
import { AppError } from "../utils/errors.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

/** How big one workspace is, and whether the host can afford it.
 *
 *  plan.md §12.1. Every project container was sized from one pair of numbers —
 *  `CONTAINER_MEMORY_MB` and `CONTAINER_CPUS` — so every workspace on the host
 *  was the same size as every other. §10.5's `unshared` flag already raises
 *  that pair on a personal deployment, which is why this is a smaller gap than
 *  it first looked; what it does not do is let the Rust workspace that wants
 *  8 GB differ from the eleven that idle at 512 MB, and that difference is
 *  most of the reason to keep a workspace on a server at all.
 *
 *  **The line this walks, and it is §6 decision 15's.** That decision says a
 *  plan may promise more of what the platform ALLOCATES and must never promise
 *  more of what the host HAS: a tier that sells more memory per container than
 *  the machine can give is a promise kept by an OOM kill in somebody's
 *  terminal. So a size is deliberately **not** a plan entitlement here. It is
 *  an allocation, checked against what is actually running at the moment
 *  somebody asks for it — a sum this server can do, rather than a promise made
 *  in advance to a tenant who will collect on it later.
 */

// Its own client, as every other module here has one. Nothing is shared
// between them but the socket.
const docker = new Docker();

/** Floors and ceilings on a single workspace.
 *
 *  The floor is not arbitrary: below about 256 MB a package manager cannot
 *  link a dependency tree, and a workspace that cannot install anything is not
 *  a workspace. The ceiling is the host's, computed below — this pair only
 *  catches the obviously wrong number before any of the arithmetic runs.
 */
export const MIN_MEMORY_MB = 256;
export const MIN_CPUS = 0.25;
/** Above this a request is refused on its face rather than measured. Not a
 *  capacity rule — a typo guard, for the 80000 that was meant to be 8000. */
export const MAX_CPUS = 64;

/** What the host keeps for itself.
 *
 *  This server, Postgres, the egress gateway, any managed database container,
 *  and the operating system underneath all of them. Without a reserve the
 *  budget below would hand out every byte the machine has and the first thing
 *  killed would be the thing doing the handing out.
 */
function reserveMb(): number {
  return env.HOST_MEMORY_RESERVE_MB;
}

interface HostMemory {
  totalMb: number;
  at: number;
}

let cached: HostMemory | undefined;
/** Physical memory does not change while a process runs — except that it does,
 *  on a VM that was resized under us. An hour is short enough to notice that
 *  and long enough that this is not a `docker info` per request. */
const HOST_MEMORY_TTL_MS = 60 * 60 * 1000;

export function forgetHostMemory(): void {
  cached = undefined;
}

/** How much memory the host has, in MB.
 *
 *  Asked of Docker rather than of `os.totalmem()`, because the number that
 *  matters is the one the daemon will enforce against — on Docker Desktop and
 *  in a VM those differ, and the daemon's is the one that kills a container.
 */
async function hostMemoryMb(): Promise<number> {
  if (env.HOST_MEMORY_MB) return env.HOST_MEMORY_MB;

  const now = Date.now();
  if (cached && now - cached.at < HOST_MEMORY_TTL_MS) return cached.totalMb;

  const info = (await docker.info()) as { MemTotal?: number };
  const bytes = typeof info.MemTotal === "number" ? info.MemTotal : 0;
  const totalMb = Math.floor(bytes / 1024 / 1024);

  // A daemon that will not say is not a reason to refuse every resize, but it
  // IS a reason not to invent a budget: fall back to the default size times
  // the container cap, which is exactly what the machine was already assumed
  // to hold before this file existed.
  const resolved =
    totalMb > 0
      ? totalMb
      : env.CONTAINER_MEMORY_MB * env.MAX_CONCURRENT_CONTAINERS + reserveMb();

  if (totalMb <= 0) {
    logger.warn("docker did not report host memory; assuming the old budget", {
      assumedMb: resolved,
    });
  }

  cached = { totalMb: resolved, at: now };
  return resolved;
}

/** Everything a workspace may be given, once the host has kept its share. */
export async function budgetMb(): Promise<number> {
  return Math.max(MIN_MEMORY_MB, (await hostMemoryMb()) - reserveMb());
}

export interface WorkspaceSize {
  memoryMb: number;
  cpus: number;
  /** False when both numbers came from the deployment default, which is what
   *  a screen needs to say "default" rather than repeat a figure the user did
   *  not choose. */
  custom: boolean;
}

function sizeOf(row: {
  memoryMb?: number | null;
  cpus?: number | null;
}): WorkspaceSize {
  // `?? null` and not `!== null`, because undefined is a third state and it
  // means the same as unset: a caller that selected neither column, or a row
  // read before this migration ran, must not read as custom. Getting that
  // wrong makes every default-sized workspace take the capacity check on the
  // start path, which is the one place it was deliberately exempt.
  const memoryMb = row.memoryMb ?? null;
  const cpus = row.cpus ?? null;

  return {
    memoryMb: memoryMb ?? env.CONTAINER_MEMORY_MB,
    cpus: cpus ?? env.CONTAINER_CPUS,
    custom: memoryMb !== null || cpus !== null,
  };
}

/** The size to start this project's container at.
 *
 *  Falls back to the deployment default for a project that has never been
 *  sized, and for one that has been deleted from under a caller — a container
 *  start that raced a delete must not throw here, because the caller's own
 *  guards are what should refuse it.
 */
export async function resolveSize(projectId: string): Promise<WorkspaceSize> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { memoryMb: true, cpus: true },
  });

  return sizeOf(row ?? { memoryMb: null, cpus: null });
}

/** What the running containers have been promised, in MB.
 *
 *  Read from the database rather than from `docker stats`, and the difference
 *  matters: this is what was ALLOCATED, not what is in use. A container using
 *  40 MB of its 2048 still has 2048 reserved against the next OOM, and sizing
 *  the next workspace against current usage is how a machine is oversubscribed
 *  by exactly the amount everything happens to be idle by.
 */
export async function committedMb(runningProjectIds: string[]): Promise<number> {
  if (runningProjectIds.length === 0) return 0;

  const rows = await prisma.project.findMany({
    where: { id: { in: runningProjectIds } },
    select: { memoryMb: true },
  });

  // A running container whose project row is gone still holds its memory, so
  // the ones that did not come back are counted at the default rather than at
  // zero.
  const missing = runningProjectIds.length - rows.length;

  return (
    rows.reduce((total, row) => total + (row.memoryMb ?? env.CONTAINER_MEMORY_MB), 0) +
    missing * env.CONTAINER_MEMORY_MB
  );
}

export interface SizeRequest {
  memoryMb?: number | null;
  cpus?: number | null;
}

/** Validates a requested size against the host, and against arithmetic.
 *
 *  Separated from the write so the container start path can ask the same
 *  question without a user in the room.
 */
export async function assertFits(
  projectId: string,
  memoryMb: number,
  runningProjectIds: string[],
): Promise<void> {
  const budget = await budgetMb();

  if (memoryMb > budget) {
    // The honest refusal: not "you may not have this", but "this machine does
    // not have it". A message naming both numbers is the difference between a
    // user resizing their VM and a user filing a bug.
    throw new AppError(
      400,
      "TOO_LARGE",
      `This host can give a workspace at most ${String(budget)} MB ` +
        `(${String(await hostMemoryMb())} MB total, less ${String(reserveMb())} MB ` +
        `kept for the server itself).`,
    );
  }

  // Everything running EXCEPT this project: resizing a workspace that is
  // already up replaces its allocation rather than adding to it, and counting
  // it twice would refuse every increase on a busy host.
  const others = runningProjectIds.filter((id) => id !== projectId);
  const inUse = await committedMb(others);

  if (inUse + memoryMb > budget) {
    throw new AppError(
      409,
      "NO_ROOM",
      `${String(inUse)} MB of ${String(budget)} MB is already committed to ` +
        `running workspaces. Stop one, or ask for at most ` +
        `${String(Math.max(0, budget - inUse))} MB.`,
    );
  }
}

/** Sets a workspace's size, or clears it back to the deployment default.
 *
 *  Ownership is the caller's to check — every route here reaches this through
 *  `getProjectAccess`, and a second, weaker check inside the service is how
 *  two answers to one question get out of step.
 *
 *  **Does not resize a running container**, and says so rather than pretending:
 *  Docker can update a running container's memory, but the process inside it
 *  has already read `/proc/meminfo` and sized its heap. A Node process told it
 *  had 512 MB does not start using 8 GB because the cgroup changed underneath
 *  it, so the honest thing is to apply this on next start.
 */
export async function setWorkspaceSize(
  projectId: string,
  request: SizeRequest,
  runningProjectIds: string[],
): Promise<WorkspaceSize> {
  const memoryMb = request.memoryMb ?? null;
  const cpus = request.cpus ?? null;

  if (memoryMb !== null) {
    if (!Number.isInteger(memoryMb) || memoryMb < MIN_MEMORY_MB) {
      throw new AppError(
        400,
        "TOO_SMALL",
        `A workspace needs at least ${String(MIN_MEMORY_MB)} MB — below that a ` +
          `package manager cannot link a dependency tree.`,
      );
    }

    await assertFits(projectId, memoryMb, runningProjectIds);
  }

  if (cpus !== null && (!Number.isFinite(cpus) || cpus < MIN_CPUS || cpus > MAX_CPUS)) {
    throw new AppError(
      400,
      "BAD_CPUS",
      `CPUs must be between ${String(MIN_CPUS)} and ${String(MAX_CPUS)}.`,
    );
  }

  const row = await prisma.project.update({
    where: { id: projectId },
    data: { memoryMb, cpus },
    select: { memoryMb: true, cpus: true },
  });

  logger.info("workspace resized", { projectId, memoryMb, cpus });
  return sizeOf(row);
}
