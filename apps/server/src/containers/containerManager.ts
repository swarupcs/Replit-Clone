import Docker from "dockerode";
import type { Container, ContainerInfo } from "dockerode";
import { env, previewTargetMode } from "../config/env.js";
import { projectRoot } from "../utils/projectPaths.js";
import { AppError } from "../utils/errors.js";
import { getTemplate } from "../templates/registry.js";

const docker = new Docker();

/** User-defined bridge the sandboxes share. Being off the default bridge means
 *  containers cannot reach host services that bind to the docker0 gateway. */
export const SANDBOX_NETWORK = "replit-clone-sandbox";

const CONTAINER_PREFIX = "rc-project-";

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

/** Starts (or reuses) the container for a project.
 *
 *  Unlike the original, this reuses a stopped container instead of destroying
 *  and recreating it, and applies hard resource limits — without them a single
 *  `npm install` or a fork bomb could take the whole VM down.
 */
export async function ensureContainer(projectId: string): Promise<Container> {
  const existing = await findContainer(projectId);

  if (existing) {
    const container = docker.getContainer(existing.Id);

    if (existing.State === "running") {
      lastActiveAt.set(projectId, Date.now());
      return container;
    }

    await container.start();
    lastActiveAt.set(projectId, Date.now());
    return container;
  }

  if ((await runningCount()) >= env.MAX_CONCURRENT_CONTAINERS) {
    throw new AppError(
      503,
      "CAPACITY",
      "The server is at capacity. Close another project and try again.",
    );
  }

  const template = await templateForProject(projectId);

  // In host-loopback mode the dev port is published on 127.0.0.1 with a random
  // host port, because Docker Desktop gives a Windows/macOS host no route to
  // container IPs. It is never bound on 0.0.0.0, so nothing is reachable from
  // outside this machine � the browser always goes through /preview.
  const publishPort = previewTargetMode === "host-loopback";
  const devPortKey = `${template.devPort}/tcp`;

  const container = await docker.createContainer({
    Image: template.image,
    name: containerName(projectId),
    Tty: true,
    OpenStdin: true,
    User: "sandbox",
    WorkingDir: "/home/sandbox/app",
    Env: [
      "HOST=0.0.0.0",
      // Vite serves under this base so the proxied path resolves correctly.
      `PREVIEW_BASE=/preview/${projectId}/`,
    ],
    ...(publishPort ? { ExposedPorts: { [devPortKey]: {} } } : {}),
    // Idle process; terminals attach with `docker exec`.
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      ...(publishPort
        ? {
            PortBindings: {
              [devPortKey]: [{ HostIp: "127.0.0.1", HostPort: "0" }],
            },
          }
        : {}),
      Binds: [`${projectRoot(projectId)}:/home/sandbox/app`],
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
): Promise<string | undefined> {
  const info = await findContainer(projectId);
  if (!info || info.State !== "running") return undefined;

  const inspected = await docker.getContainer(info.Id).inspect();
  const template = await templateForProject(projectId);
  const devPortKey = `${template.devPort}/tcp`;

  if (previewTargetMode === "host-loopback") {
    const hostPort =
      inspected.NetworkSettings?.Ports?.[devPortKey]?.[0]?.HostPort;
    return hostPort ? `http://127.0.0.1:${hostPort}` : undefined;
  }

  const address =
    inspected.NetworkSettings?.Networks?.[SANDBOX_NETWORK]?.IPAddress;
  return address ? `http://${address}:${template.devPort}` : undefined;
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

          console.log(`Reaping idle container for project ${name}`);
          await docker.getContainer(info.Id).stop({ t: 5 }).catch(() => {});
        }
      } catch (error) {
        console.error("Idle reaper failed:", error);
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
