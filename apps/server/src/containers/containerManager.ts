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
import { SANDBOX_NETWORK } from "./sandboxNetwork.js";
import { proxyEnv } from "./egressGateway.js";
import { increment, registerGauge } from "../lib/metrics.js";
import {
  DevcontainerError,
  imageAllowed,
  isValidImageReference,
  readDevcontainer,
  resolveWorkspaceFolder,
  setDevcontainerStatus,
  type DevcontainerConfig,
} from "./devcontainer.js";
import { execCapture } from "./execCapture.js";

const docker = new Docker();

/** User-defined bridge the sandboxes share. Being off the default bridge means
 *  containers cannot reach host services that bind to the docker0 gateway. */
// Re-exported so existing importers keep working; it lives in its own
// module now because the database service needs it too.
export { SANDBOX_NETWORK, ensureNetwork } from "./sandboxNetwork.js";

const CONTAINER_PREFIX = "rc-project-";
/** Kept here rather than imported from the database service, which imports
 *  this module — the cycle would be real, and the string is the contract. */
const DB_CONTAINER_PREFIX = "rc-db-";
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
export function envSignature(
  vars: Record<string, string>,
  /** The devcontainer config in force, or null.
   *
   *  Part of the signature because it decides the image, the ports, the working
   *  directory and the environment -- every one of which a running container
   *  holds for its whole life. Without it, editing `devcontainer.json` would
   *  change nothing until something else happened to force a rebuild, which is
   *  the same defect the environment variables had.
   */
  devcontainer?: DevcontainerConfig | null,
): string {
  const stable = JSON.stringify(
    Object.keys(vars)
      .sort()
      .map((name) => [name, vars[name] ?? ""]),
  );

  const hash = createHash("sha256").update(stable);

  if (devcontainer) {
    // `source` and `unsupported` are left out on purpose: they describe how
    // this READ the file, not what the container is, so rewording a refusal
    // must not cost the user a rebuild.
    hash.update(
      JSON.stringify({
        image: devcontainer.image ?? null,
        containerEnv: devcontainer.containerEnv ?? null,
        forwardPorts: devcontainer.forwardPorts ?? null,
        workspaceFolder: devcontainer.workspaceFolder ?? null,
        postCreateCommand: devcontainer.postCreateCommand ?? null,
        postStartCommand: devcontainer.postStartCommand ?? null,
      }),
    );
  }

  return hash.digest("hex").slice(0, 32);
}

/** Where a project's tree is mounted inside its container.
 *
 *  Fixed by this platform, which is what `workspaceFolder` is confined to and
 *  what `workspaceMount` is refused for. */
export const MOUNT_POINT = "/home/sandbox/app";

/** Reads a project's devcontainer, recording anything wrong with it.
 *
 *  A broken config must NOT stop the container starting. Being locked out of
 *  the project by the very file you are trying to fix is the worst failure
 *  available here, so this falls back to the template's defaults and records
 *  the reason -- which the editor then shows, because a file that silently did
 *  nothing is the second worst.
 */
async function devcontainerFor(
  projectId: string,
): Promise<DevcontainerConfig | null> {
  try {
    const config = await readDevcontainer(projectId);
    setDevcontainerStatus(projectId, { config, error: null });
    return config;
  } catch (error) {
    const reason =
      error instanceof DevcontainerError
        ? error.message
        : "The devcontainer config could not be read.";
    logger.warn("devcontainer ignored", { projectId, reason });
    setDevcontainerStatus(projectId, { config: null, error: reason });
    return null;
  }
}

/** The image to run, honouring the devcontainer only if it is permitted.
 *
 *  `image` decides what code runs in the sandbox, so an arbitrary one is a
 *  supply-chain decision plus unbounded pull bandwidth and disk. The allowlist
 *  is the deployment's answer to that; a refusal names the setting, because
 *  "not permitted" with no way to find out what is permitted is not a message
 *  anybody can act on.
 */
function imageFor(
  projectId: string,
  templateImage: string,
  devcontainer: DevcontainerConfig | null,
): string {
  const wanted = devcontainer?.image;
  if (!wanted) return templateImage;

  if (!isValidImageReference(wanted)) {
    setDevcontainerStatus(projectId, {
      error: `"${wanted}" is not a valid image reference, so the template's image was used instead.`,
    });
    return templateImage;
  }

  if (!imageAllowed(wanted, env.DEVCONTAINER_IMAGE_ALLOWLIST)) {
    setDevcontainerStatus(projectId, {
      error:
        `The image "${wanted}" is not permitted on this server, so the ` +
        `template's image was used instead. Permitted: ` +
        `${env.DEVCONTAINER_IMAGE_ALLOWLIST.join(", ")}. An operator can widen ` +
        `this with DEVCONTAINER_IMAGE_ALLOWLIST.`,
    });
    return templateImage;
  }

  return wanted;
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

/** The project id behind a sandbox container's names.
 *
 *  Docker gives a container a list of names and the prefix match is a
 *  substring one, so this looks for the name that actually starts with our
 *  prefix and takes what follows it. */
function projectIdFromNames(names: string[]): string | undefined {
  for (const prefix of [CONTAINER_PREFIX, DB_CONTAINER_PREFIX]) {
    const name = names.find((entry) => entry.startsWith(`/${prefix}`));
    if (name) return name.slice(`/${prefix}`.length);
  }
  return undefined;
}

/** Every container this platform runs, projects and their databases both.
 *
 *  §7.4 is explicit that database containers have to be counted: they are a
 *  full container against a budget chosen for three, and leaving them out
 *  would silently double the effective cap on the VM the defaults were
 *  picked for. A database-backed project costs two slots, and an operator
 *  who wants more raises the cap deliberately.
 */
async function runningCount(): Promise<number> {
  const containers = await docker.listContainers({
    filters: { name: [CONTAINER_PREFIX, DB_CONTAINER_PREFIX] },
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

/** Serialises the capacity checks across DIFFERENT projects too.
 *
 *  `starting` is keyed by project, which is what stops two callers racing over
 *  the same one. But the global cap and the per-user budget are counts of
 *  every container on the machine, read inside that per-project section — so
 *  several different projects starting at once all read the same figure, all
 *  passed, and the limit was quietly exceeded by however many arrived
 *  together. This makes the count-and-create step one at a time.
 */
let capacityGate: Promise<unknown> = Promise.resolve();

function withCapacityGate<T>(work: () => Promise<T>): Promise<T> {
  const next = capacityGate.then(work, work);

  // The chain must not break on a rejection, or every later start inherits it.
  capacityGate = next.catch(() => undefined);

  return next;
}

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
  // Before the signature, because the config is part of it: editing
  // devcontainer.json has to rebuild the container, exactly as changing a
  // variable does.
  const devcontainer = await devcontainerFor(projectId);
  const signature = envSignature(envVars, devcontainer);

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
      // A stopped container that is started again has been "started" as far as
      // the spec is concerned, so postStart runs -- but postCreate does not,
      // which is the whole distinction between the two.
      await runLifecycle(projectId, container, devcontainer, "start");
      return container;
    }

    // The variables changed. A container cannot be given new ones, so the only
    // way for them to take effect is to build it again. Files live in the bind
    // mount and package caches in a named volume, so neither is lost.
    logger.info("rebuilding container for changed environment", { projectId });
    await docker.getContainer(existing.Id).remove({ force: true }).catch(() => {});
  }

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
  // The template's ports, plus anything the devcontainer forwards. Deduplicated
  // because Docker rejects a duplicate exposed port, and a devcontainer naming
  // the port its template already knew about is the ordinary case rather than a
  // mistake.
  const previewPorts = [
    ...new Set([
      template.devPort,
      ...(template.extraPorts ?? []),
      ...(devcontainer?.forwardPorts ?? []),
    ]),
  ];

  const exposedPorts = Object.fromEntries(
    previewPorts.map((port) => [`${String(port)}/tcp`, {}]),
  );
  const portBindings = Object.fromEntries(
    previewPorts.map((port) => [
      `${String(port)}/tcp`,
      [{ HostIp: "127.0.0.1", HostPort: "0" }],
    ]),
  );

  const image = imageFor(projectId, template.image, devcontainer);
  const workspaceFolder = resolveWorkspaceFolder(
    devcontainer?.workspaceFolder,
    MOUNT_POINT,
  );

  const container = await withCapacityGate(async () => {
    // Counted and created without interruption, so two projects starting
    // together cannot both read the same figure and both pass.
    if ((await runningCount()) >= env.MAX_CONCURRENT_CONTAINERS) {
      increment("containers_capacity_rejected");
      throw new AppError(
        503,
        "CAPACITY",
        "The server is at capacity. Close another project and try again.",
      );
    }

    await assertUserContainerBudget(projectId);

    return docker.createContainer({
      Image: image,
      name: containerName(projectId),
      Tty: true,
      OpenStdin: true,
      // Matched to the bind mount's owner, because a bind mount keeps the host's
      // ownership and the image's own chown is masked by it. The execs that
      // terminals and the Run button open leave `User` unset so Docker inherits
      // this, rather than restating a uid that could drift from it.
      User: await containerUser(projectId),
      WorkingDir: workspaceFolder,
      Env: [
        "HOST=0.0.0.0",
        // Vite serves under this base so the proxied path resolves correctly.
        `PREVIEW_BASE=/preview/${projectId}/`,
        // Where the way out is, when there is a controlled one. Empty when
        // egress filtering is off. These point tools at the gateway; they do
        // not enforce anything — see `egressGateway.proxyEnv`.
        ...proxyEnv(),
        // The devcontainer's own variables, before the project's. It is a file
        // in the repository and the project's are the secret store, so where
        // the two name the same variable the secret wins -- otherwise a
        // committed placeholder would quietly override a real credential.
        ...toDockerEnv(devcontainer?.containerEnv ?? {}),
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
          `${projectRoot(projectId)}:${MOUNT_POINT}`,
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
  });

  await container.start();
  lastActiveAt.set(projectId, Date.now());
  increment("containers_started");
  logger.info("container started", { projectId, image });

  // A container that was just created has been created, so both run -- in the
  // order the spec gives them.
  await runLifecycle(projectId, container, devcontainer, "create");

  return container;
}

/** Runs a devcontainer's lifecycle commands.
 *
 *  Best-effort, and deliberately so: these are arbitrary commands out of a file
 *  in the repository, and one that fails must leave the user with a running
 *  container and a readable reason rather than a project that will not open.
 *  The output is recorded for the editor to show, because a `postCreateCommand`
 *  that failed silently is indistinguishable from one that never ran.
 *
 *  `phase` is "create" for a container that has just been made -- which runs
 *  postCreate and then postStart -- and "start" for one being started again,
 *  which runs only postStart.
 */
async function runLifecycle(
  projectId: string,
  container: Container,
  devcontainer: DevcontainerConfig | null,
  phase: "create" | "start",
): Promise<void> {
  if (!devcontainer) return;

  const commands = [
    ...(phase === "create" ? (devcontainer.postCreateCommand ?? []) : []),
    ...(devcontainer.postStartCommand ?? []),
  ];
  if (commands.length === 0) return;

  const workingDir = resolveWorkspaceFolder(
    devcontainer.workspaceFolder,
    MOUNT_POINT,
  );
  const budgetMs = env.DEVCONTAINER_LIFECYCLE_TIMEOUT_MINUTES * 60 * 1000;
  const startedAt = Date.now();

  setDevcontainerStatus(projectId, { running: true, lifecycleLog: "" });
  let log = "";

  for (const command of commands) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      log += `\n$ ${command}\n[skipped: the lifecycle budget was already spent]\n`;
      break;
    }

    log += `\n$ ${command}\n`;

    // Through `sh -c` because the spec says a string command is run by a
    // shell. The string comes from the project's own repository, which is the
    // same trust level as the run command and the terminal -- this is the
    // user's container, and there is nothing here they could not type into it.
    const result = await withDeadline(
      execCapture(container, ["sh", "-c", command], { workingDir }),
      remaining,
    );

    if (!result) {
      log += `[gave up after ${String(env.DEVCONTAINER_LIFECYCLE_TIMEOUT_MINUTES)} minutes]\n`;
      break;
    }

    log += [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
    if (result.exitCode !== 0) {
      log += `\n[exited ${String(result.exitCode)}]\n`;
      // Stopped rather than pressed on: a postCreate that failed has usually
      // left the environment half-built, and running the next command against
      // it produces a second, more confusing failure.
      break;
    }
  }

  setDevcontainerStatus(projectId, { running: false, lifecycleLog: log.trim() });
}

/** Resolves to undefined when the work outlives its budget.
 *
 *  The exec keeps running inside the container -- there is no way to reach in
 *  and stop it -- but the START stops waiting, which is what matters: a
 *  `sleep infinity` in a postCreateCommand must not hold a project closed.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
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

/** The project's container, but only if one exists and is running.
 *
 *  Unlike `ensureContainer` this creates nothing. It is for asking questions
 *  about a project that may well have no container, where starting one would
 *  itself be the wrong answer — the run reconciler, most of all, which must be
 *  able to say "nothing is running here" without making that false.
 */
/** The image a project's container is actually running, or null when it has
 *  none yet.
 *
 *  Read from Docker rather than recomputed, because the point of showing it is
 *  to answer "did my devcontainer's image take effect" -- and a container built
 *  before the config changed is running the old one until it is rebuilt, which
 *  recomputing would hide.
 */
export async function runningImage(projectId: string): Promise<string | null> {
  const existing = await findContainer(assertValidProjectId(projectId)).catch(
    () => undefined,
  );
  return existing?.Image ?? null;
}

export async function getRunningContainer(
  projectId: string,
): Promise<Container | undefined> {
  const info = await findContainer(projectId);
  if (!info || info.State !== "running") return undefined;
  return docker.getContainer(info.Id);
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

  const container = docker.getContainer(info.Id);
  // Stop before remove: `remove({ force })` on a running container with an
  // attached exec stream can be refused by the daemon, and with the failure
  // swallowed the container outlived its project — unreaped, because nothing
  // else knows its id once the row is gone.
  await container.stop({ t: 2 }).catch(() => {});
  await container.remove({ force: true }).catch(() => {});
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
/** Called when a project's container is reaped, so its database can be
 *  stopped with it. Injected rather than imported: this module is below the
 *  services in the dependency order and pulling one down would invert it. */
let onProjectReaped: ((projectId: string) => Promise<void>) | undefined;

export function setOnProjectReaped(
  handler: (projectId: string) => Promise<void>,
): void {
  onProjectReaped = handler;
}

export function startIdleReaper(): void {
  const idleMs = env.CONTAINER_IDLE_MINUTES * 60 * 1000;

  reaperTimer = setInterval(() => {
    void (async () => {
      try {
        const containers = await docker.listContainers({
          filters: { name: [CONTAINER_PREFIX] },
        });

        for (const info of containers) {
          // Parsed the way reconcileOnBoot does. `Names[0].replace(prefix, "")`
          // was unanchored and looked at only the first of several possible
          // names, so it could yield the wrong id — and a wrong id means
          // checking a different project's attachment count before stopping
          // this one.
          const name = projectIdFromNames(info.Names);
          if (!name) continue;

          if ((activeAttachments.get(name) ?? 0) > 0) continue;

          const idleSince = lastActiveAt.get(name) ?? info.Created * 1000;
          if (Date.now() - idleSince < idleMs) continue;

          logger.info("reaping idle container", { projectId: name });
          increment("containers_reaped");
          await docker.getContainer(info.Id).stop({ t: 5 }).catch(() => {});

          // §7.4: the pair is one unit. A project's container stopping while
          // its database keeps running is a memory leak with extra steps —
          // and the reverse, stopping the database under a running app, is
          // an outage the user did not cause. Only this direction is safe,
          // and only because the app has already gone.
          await onProjectReaped?.(name);
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
    const projectId = projectIdFromNames(info.Names);
    if (!projectId) continue;

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
    .listContainers({
      filters: { name: [CONTAINER_PREFIX, DB_CONTAINER_PREFIX] },
    })
    .catch(() => []);

  // A project's database counts against its owner, the same as the project
  // container does — it is running on their behalf and on this VM's budget.
  const theirs = running.filter((info) => {
    const projectId = projectIdFromNames(info.Names);
    return projectId !== undefined && ownedIds.has(projectId);
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
