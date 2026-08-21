import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import Docker from "dockerode";
import type { Container, ContainerInfo, ContainerStats as DockerStats } from "dockerode";
import { env, previewTargetMode } from "../config/env.js";
import {
  assertValidProjectId,
  claimForSandbox,
  containerUser,
  projectRoot,
  SANDBOX_UID,
} from "../utils/projectPaths.js";
import { AppError } from "../utils/errors.js";
import { getTemplate } from "../templates/registry.js";
import { logger } from "../lib/logger.js";
import { getEnvVars, toDockerEnv } from "../service/projectEnvService.js";
import { increment, registerGauge } from "../lib/metrics.js";

const docker = new Docker();

/** User-defined bridge the sandboxes share. Being off the default bridge means
 *  containers cannot reach host services that bind to the docker0 gateway. */
export const SANDBOX_NETWORK = "replit-clone-sandbox";

const CONTAINER_PREFIX = "rc-project-";
const CACHE_VOLUME_PREFIX = "rc-cache-";

/** Named volume holding a project's package caches. */
function cacheVolumeName(projectId: string): string {
  return `${CACHE_VOLUME_PREFIX}${assertValidProjectId(projectId)}`;
}

/** Removes a project's cache volume. Only for deletion — a restart must keep
 *  it, since keeping it is the entire point. */
export async function removeCacheVolume(projectId: string): Promise<void> {
  await docker
    .getVolume(cacheVolumeName(projectId))
    .remove({ force: true })
    .catch(() => {
      // Never created, or already gone.
    });
}

/** Label recording which environment a container was built with.
 *
 *  Variables are handed to Docker at CREATE time and are fixed for the
 *  container's life. Since a stopped container is reused rather than rebuilt,
 *  saving new variables reached a running project only if it happened to have
 *  no container yet — which for anyone actually working was never. The value
 *  saved, the dev server restarted, and nothing changed.
 */
const ENV_SIGNATURE_LABEL = "rc.env-signature";

/** A stable fingerprint of a project's variables.
 *
 *  Sorted, so the same set written in a different order is not mistaken for a
 *  change and does not cost the user an unasked-for rebuild.
 *
 *  Serialised as JSON rather than joined with a separator, because a value may
 *  contain anything — a newline in a private key, an `=` in a connection
 *  string. Joining made `{A: "1\nB=2"}` hash identically to `{A: "1", B: "2"}`,
 *  which is this defect all over again: a real change that does not look like
 *  one, so the container is never rebuilt.
 */
export function envSignature(vars: Record<string, string>): string {
  const stable = JSON.stringify(
    Object.keys(vars)
      .sort()
      .map((name) => [name, vars[name] ?? ""]),
  );

  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function containerName(projectId: string): string {
  return `${CONTAINER_PREFIX}${projectId}`;
}

/** Tracks live attachments (editor sockets and terminals) per project so the
 *  reaper only stops containers nobody is using. */
const activeAttachments = new Map<string, number>();
const lastActiveAt = new Map<string, number>();

export function attach(projectId: string): void {
  activeAttachments.set(projectId, (activeAttachments.get(projectId) ?? 0) + 1);
  lastActiveAt.set(projectId, Date.now());
}

export function detach(projectId: string): void {
  const next = (activeAttachments.get(projectId) ?? 1) - 1;
  if (next <= 0) activeAttachments.delete(projectId);
  else activeAttachments.set(projectId, next);
  lastActiveAt.set(projectId, Date.now());
}

/** Ensures the sandbox network exists. Idempotent. */
export async function ensureNetwork(): Promise<void> {
  const networks = await docker.listNetworks({
    filters: { name: [SANDBOX_NETWORK] },
  });

  if (networks.some((network) => network.Name === SANDBOX_NETWORK)) return;

  await docker.createNetwork({
    Name: SANDBOX_NETWORK,
    Driver: "bridge",
    // Keeps sandboxes off the default bridge, which several unrelated
    // containers on this host also share.
    Internal: false,
  });
}

/** Finds a container by EXACT name.
 *
 *  dockerode ignores a bare `name` option — it needs `filters` — so the
 *  original code listed every container and could force-remove an unrelated
 *  one. Docker's name filter is also a substring match, hence the exact
 *  comparison afterwards.
 */
async function findContainer(
  projectId: string,
): Promise<ContainerInfo | undefined> {
  const name = containerName(projectId);
  const containers = await docker.listContainers({
    all: true,
    filters: { name: [name] },
  });

  return containers.find((info) => info.Names.includes(`/${name}`));
}

async function runningCount(): Promise<number> {
  const containers = await docker.listContainers({
    filters: { name: [CONTAINER_PREFIX] },
  });
  return containers.length;
}

/** In-flight `ensureContainer` calls, so concurrent callers share one attempt.
 *
 *  Opening a project fires this from the editor socket, from each terminal and
 *  from the preview guard, often within the same tick. Without this they could
 *  all miss the "already exists" check and race into createContainer, where
 *  every loser failed on the duplicate name — and they could likewise all clear
 *  the MAX_CONCURRENT_CONTAINERS check and overshoot the budget together.
 */
const starting = new Map<string, Promise<Container>>();

export async function ensureContainer(projectId: string): Promise<Container> {
  const inFlight = starting.get(projectId);
  if (inFlight) return inFlight;

  const attempt = startContainer(projectId).finally(() => {
    starting.delete(projectId);
  });

  starting.set(projectId, attempt);
  return attempt;
}

/** Starts (or reuses) the container for a project.
 *
 *  Unlike the original, this reuses a stopped container instead of destroying
 *  and recreating it, and applies hard resource limits — without them a single
 *  `npm install` or a fork bomb could take the whole VM down.
 *
 *  Always reached through `ensureContainer`, which serialises concurrent calls.
 */
async function startContainer(projectId: string): Promise<Container> {
  const envVars = await getEnvVars(projectId);
  const signature = envSignature(envVars);

  const existing = await findContainer(projectId);

  if (existing) {
    // Checked before the state, because a RUNNING container is exactly the one
    // that would otherwise keep serving the old environment forever.
    if (existing.Labels?.[ENV_SIGNATURE_LABEL] === signature) {
      const container = docker.getContainer(existing.Id);

      if (existing.State === "running") {
        lastActiveAt.set(projectId, Date.now());
        return container;
      }

      await container.start();
      lastActiveAt.set(projectId, Date.now());
      return container;
    }

    // The variables changed. A container cannot be given new ones, so the only
    // way for them to take effect is to build it again. Files live in the bind
    // mount and package caches in a named volume, so neither is lost.
    logger.info("rebuilding container for changed environment", { projectId });
    await docker.getContainer(existing.Id).remove({ force: true }).catch(() => {});
  }

  if ((await runningCount()) >= env.MAX_CONCURRENT_CONTAINERS) {
    increment("containers_capacity_rejected");
    throw new AppError(
      503,
      "CAPACITY",
      "The server is at capacity. Close another project and try again.",
    );
  }

  await assertUserContainerBudget(projectId);

  const template = await templateForProject(projectId);

  // Projects scaffolded before ownership was claimed still belong to whoever
  // the server ran as then. Guarded by a stat so the recursive walk does not
  // run on every start, and best-effort because a non-root server cannot hand
  // the tree to another uid — there `containerUser` adapts instead.
  const root = await fsp.stat(projectRoot(projectId)).catch(() => undefined);
  if (root && root.uid !== SANDBOX_UID) {
    await claimForSandbox(projectRoot(projectId)).catch(() => {});
  }

  // In host-loopback mode the dev port is published on 127.0.0.1 with a random
  // host port, because Docker Desktop gives a Windows/macOS host no route to
  // container IPs. It is never bound on 0.0.0.0, so nothing is reachable from
  // outside this machine — the browser always goes through /preview.
  const publishPort = previewTargetMode === "host-loopback";
  const previewPorts = [template.devPort, ...(template.extraPorts ?? [])];

  const exposedPorts = Object.fromEntries(
    previewPorts.map((port) => [`${String(port)}/tcp`, {}]),
  );
  const portBindings = Object.fromEntries(
    previewPorts.map((port) => [
      `${String(port)}/tcp`,
      [{ HostIp: "127.0.0.1", HostPort: "0" }],
    ]),
  );

  const container = await docker.createContainer({
    Image: template.image,
    name: containerName(projectId),
    Tty: true,
    OpenStdin: true,
    // Matched to the bind mount's owner, because a bind mount keeps the host's
    // ownership and the image's own chown is masked by it. The execs that
    // terminals and the Run button open leave `User` unset so Docker inherits
    // this, rather than restating a uid that could drift from it.
    User: await containerUser(projectId),
    WorkingDir: "/home/sandbox/app",
    Env: [
      "HOST=0.0.0.0",
      // Vite serves under this base so the proxied path resolves correctly.
      `PREVIEW_BASE=/preview/${projectId}/`,
      // The project's own variables. Last, so they cannot shadow the two above
      // — the env service already refuses those names, and this is the belt to
      // that braces.
      ...toDockerEnv(envVars),
    ],
    // What the reuse check above compares against.
    Labels: { [ENV_SIGNATURE_LABEL]: signature },
    ...(publishPort ? { ExposedPorts: exposedPorts } : {}),
    // Idle process; terminals attach with `docker exec`.
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      ...(publishPort ? { PortBindings: portBindings } : {}),
      Binds: [
        `${projectRoot(projectId)}:/home/sandbox/app`,
        // Package caches, in a named volume rather than the container's
        // writable layer. Containers are stopped when idle and removed on a
        // restart, so without this every cold start re-downloaded the whole of
        // node_modules — minutes of waiting for a project that had not changed.
        `${cacheVolumeName(projectId)}:/home/sandbox/.cache`,
      ],
      Memory: env.CONTAINER_MEMORY_MB * 1024 * 1024,
      // Equal to Memory disables swap, so a container cannot evade its limit
      // by swapping the host to death.
      MemorySwap: env.CONTAINER_MEMORY_MB * 1024 * 1024,
      NanoCpus: Math.round(env.CONTAINER_CPUS * 1e9),
      // Caps a fork bomb.
      PidsLimit: 256,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: SANDBOX_NETWORK,
      RestartPolicy: { Name: "no" },
    },
  });

  await container.start();
  lastActiveAt.set(projectId, Date.now());
  increment("containers_started");
  logger.info("container started", { projectId, image: template.image });

  return container;
}

async function templateForProject(projectId: string) {
  const { prisma } = await import("../lib/prisma.js");
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  return getTemplate(project?.template ?? "react-vite");
}

/** Base URL the preview proxy should dial for a project's dev server.
 *
 *  Replaces the old scheme where a random HOST port was published on all
 *  interfaces and the BROWSER was pointed at http://localhost:<port>. The
 *  browser now only ever talks to /preview on this server.
 */
export async function getPreviewTarget(
  projectId: string,
  port?: number,
): Promise<string | undefined> {
  const info = await findContainer(projectId);
  if (!info || info.State !== "running") return undefined;

  const inspected = await docker.getContainer(info.Id).inspect();
  const template = await templateForProject(projectId);

  // Any port the template declares, defaulting to its dev port. The registry
  // used to allow exactly one, so a project serving an API beside its frontend
  // had no way to preview the other.
  const wanted = port ?? template.devPort;
  const allowed = [template.devPort, ...(template.extraPorts ?? [])];
  if (!allowed.includes(wanted)) return undefined;

  const portKey = `${String(wanted)}/tcp`;

  if (previewTargetMode === "host-loopback") {
    const hostPort = inspected.NetworkSettings?.Ports?.[portKey]?.[0]?.HostPort;
    return hostPort ? `http://127.0.0.1:${hostPort}` : undefined;
  }

  const address =
    inspected.NetworkSettings?.Networks?.[SANDBOX_NETWORK]?.IPAddress;
  return address ? `http://${address}:${String(wanted)}` : undefined;
}

/** Ports this project's preview may be pointed at. */
export async function previewablePorts(projectId: string): Promise<number[]> {
  const template = await templateForProject(projectId);
  return [template.devPort, ...(template.extraPorts ?? [])];
}

export async function stopContainer(projectId: string): Promise<void> {
  const info = await findContainer(projectId);
  if (!info) return;

  const container = docker.getContainer(info.Id);
  await container.stop({ t: 5 }).catch(() => {});
}

export async function removeContainer(projectId: string): Promise<void> {
  const info = await findContainer(projectId);
  if (!info) return;

  await docker.getContainer(info.Id).remove({ force: true }).catch(() => {});
  activeAttachments.delete(projectId);
  lastActiveAt.delete(projectId);
}

let reaperTimer: NodeJS.Timeout | undefined;

/** Stops containers that nobody has been attached to for a while.
 *
 *  Containers were previously never stopped at all — only removed when the same
 *  project reconnected — so on a small VM every project ever opened stayed
 *  resident until the host ran out of memory.
 */
export function startIdleReaper(): void {
  const idleMs = env.CONTAINER_IDLE_MINUTES * 60 * 1000;

  reaperTimer = setInterval(() => {
    void (async () => {
      try {
        const containers = await docker.listContainers({
          filters: { name: [CONTAINER_PREFIX] },
        });

        for (const info of containers) {
          const name = info.Names[0]?.replace(`/${CONTAINER_PREFIX}`, "");
          if (!name) continue;

          if ((activeAttachments.get(name) ?? 0) > 0) continue;

          const idleSince = lastActiveAt.get(name) ?? info.Created * 1000;
          if (Date.now() - idleSince < idleMs) continue;

          logger.info("reaping idle container", { projectId: name });
          increment("containers_reaped");
          await docker.getContainer(info.Id).stop({ t: 5 }).catch(() => {});
        }
      } catch (error) {
        logger.error("idle reaper failed", error);
      }
    })();
  }, 60_000);

  reaperTimer.unref();
}

/** Stops every sandbox container. Called on shutdown so a restart does not
 *  leave orphans holding memory. */
export async function stopAllContainers(): Promise<void> {
  const containers = await docker
    .listContainers({ filters: { name: [CONTAINER_PREFIX] } })
    .catch(() => []);

  await Promise.all(
    containers.map((info) =>
      docker.getContainer(info.Id).stop({ t: 3 }).catch(() => {}),
    ),
  );

  if (reaperTimer) clearInterval(reaperTimer);
}

/** Confirms the Docker daemon is reachable. Used by the health endpoint. */
export async function checkDocker(): Promise<void> {
  await docker.ping();
}

/** Number of sandbox containers currently running. */
export async function runningContainerCount(): Promise<number> {
  return runningCount();
}

/** Reconciles Docker and the database against each other at boot.
 *
 *  A crash or a `docker kill` leaves state neither side cleans up: containers
 *  whose project row is gone stay resident forever, and project directories
 *  with no row sit on disk taking space nobody can see or reclaim. Both used to
 *  survive indefinitely.
 *
 *  Only ever removes things that are unambiguously orphaned — a container or
 *  directory whose project does not exist. Anything still referenced is left
 *  alone, so this can never eat a live project.
 */
export async function reconcileOnBoot(): Promise<{
  containersRemoved: number;
  directoriesFound: number;
}> {
  const { prisma } = await import("../lib/prisma.js");
  const projects = await prisma.project.findMany({ select: { id: true } });
  const known = new Set(projects.map((project) => project.id));

  let containersRemoved = 0;

  const containers = await docker
    .listContainers({ all: true, filters: { name: [CONTAINER_PREFIX] } })
    .catch(() => []);

  for (const info of containers) {
    const name = info.Names.find((entry) =>
      entry.startsWith(`/${CONTAINER_PREFIX}`),
    );
    if (!name) continue;

    const projectId = name.slice(`/${CONTAINER_PREFIX}`.length);
    if (known.has(projectId)) continue;

    logger.info("removing orphaned container", { projectId });
    await docker.getContainer(info.Id).remove({ force: true }).catch(() => {});
    containersRemoved += 1;
  }

  // Directories are reported, not deleted. A row missing at boot is far more
  // likely to mean the database is not the one this server used last than that
  // the user's files are garbage, and deleting them would be unrecoverable.
  const directoriesFound = await orphanedDirectories(known);

  return { containersRemoved, directoriesFound };
}

async function orphanedDirectories(known: Set<string>): Promise<number> {
  const { PROJECTS_ROOT } = await import("../config/env.js");

  const entries = await fsp
    .readdir(PROJECTS_ROOT, { withFileTypes: true })
    .catch(() => []);

  const orphans = entries
    .filter((entry) => entry.isDirectory() && !known.has(entry.name))
    .map((entry) => entry.name);

  if (orphans.length > 0) {
    logger.warn("project directories with no database row", {
      count: orphans.length,
      // Enough to act on without printing hundreds of ids.
      examples: orphans.slice(0, 5),
    });
  }

  return orphans.length;
}

registerGauge("containers_attached", () => activeAttachments.size);

/** How long until the idle reaper would stop this project's container.
 *
 *  Null while anything is still attached. Containers used to just go away at
 *  twenty minutes with no warning, which looked like the preview breaking.
 */
export function idleStopInSeconds(projectId: string): number | null {
  if ((activeAttachments.get(projectId) ?? 0) > 0) return null;

  const since = lastActiveAt.get(projectId);
  if (since === undefined) return null;

  const idleMs = env.CONTAINER_IDLE_MINUTES * 60 * 1000;
  const remaining = Math.round((since + idleMs - Date.now()) / 1000);
  return Math.max(0, remaining);
}

/** One sample of a container's resource use, against the budget it was given.
 *
 *  The limits were always enforced and never surfaced, so an OOM kill looked
 *  like the dev server exiting for no reason at all.
 */
export async function readContainerStats(projectId: string): Promise<{
  running: boolean;
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuPercent: number;
}> {
  const limit = env.CONTAINER_MEMORY_MB * 1024 * 1024;
  const info = await findContainer(projectId);

  if (!info || info.State !== "running") {
    return {
      running: false,
      memoryBytes: 0,
      memoryLimitBytes: limit,
      cpuPercent: 0,
    };
  }

  // `stream: false` takes a single sample. Docker computes CPU from the delta
  // against the previous reading, which it includes in the same payload.
  const stats: DockerStats = await docker
    .getContainer(info.Id)
    .stats({ stream: false });

  return {
    running: true,
    memoryBytes: memoryUsage(stats),
    memoryLimitBytes: stats.memory_stats?.limit ?? limit,
    cpuPercent: cpuPercent(stats),
  };
}

/** Docker reports total memory including the page cache, which makes a
 *  container that merely read files look near its limit. Subtracting the
 *  reclaimable part is what `docker stats` itself displays. */
function memoryUsage(stats: DockerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.["inactive_file"] ?? 0;
  return Math.max(0, usage - cache);
}

function cpuPercent(stats: DockerStats): number {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);

  if (cpuDelta <= 0 || systemDelta <= 0) return 0;

  const cores = stats.cpu_stats?.online_cpus ?? 1;
  return Math.round((cpuDelta / systemDelta) * cores * 1000) / 10;
}

/** Stops one account taking every container slot on the machine.
 *
 *  Only the global cap existed, so a single user opening enough projects
 *  locked everyone else out — the machine was "at capacity" because of one
 *  person. Counted against the OWNER, so a project shared with several people
 *  costs its owner one slot rather than one each.
 */
async function assertUserContainerBudget(projectId: string): Promise<void> {
  const { prisma } = await import("../lib/prisma.js");

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) return;

  const owned = await prisma.project.findMany({
    where: { ownerId: project.ownerId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((entry) => entry.id));

  const running = await docker
    .listContainers({ filters: { name: [CONTAINER_PREFIX] } })
    .catch(() => []);

  const theirs = running.filter((info) => {
    const name = info.Names.find((entry) => entry.startsWith(`/${CONTAINER_PREFIX}`));
    return name ? ownedIds.has(name.slice(`/${CONTAINER_PREFIX}`.length)) : false;
  });

  if (theirs.length >= env.MAX_CONTAINERS_PER_USER) {
    increment("containers_capacity_rejected");
    throw new AppError(
      429,
      "USER_CONTAINER_LIMIT",
      `You already have ${String(theirs.length)} projects running. ` +
        `Close one before starting another.`,
    );
  }
}
