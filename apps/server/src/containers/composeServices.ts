import Docker from "dockerode";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { imageAllowed } from "./devcontainer.js";
import {
  ComposeError,
  type ComposeProject,
  type ComposeService,
  readCompose,
} from "./composeFile.js";

const docker = new Docker();

/** Running the services a project's compose file declares. plan.md §11.3.
 *
 *  One lifecycle unit with the project's own container: started when it
 *  starts, stopped when it is stopped or reaped, removed when the project is.
 *  That is `managedDatabaseService`'s relationship with a project generalised
 *  from one sidecar to several, which is what §11.3 said the honest first
 *  version would be.
 *
 *  **Each project's services get a network of their own, and that is the
 *  load-bearing decision in this file.** The obvious implementation puts them
 *  on `SANDBOX_NETWORK` with a network alias equal to the service name, so
 *  that the app reaches `postgres:5432` exactly as compose promises. Every
 *  sandbox on this host shares that network — so two projects both declaring a
 *  service called `postgres` would share the alias, Docker's embedded DNS
 *  would round-robin between them, and one project's app would intermittently
 *  connect to another project's database. Intermittently, which is the worst
 *  version. A per-project network makes the alias mean what the file says.
 *
 *  That network is created `Internal: true` **unconditionally**, and not only
 *  for tidiness: joining the project's container to a second, routable network
 *  would hand it a way off the host that `SANDBOX_EGRESS_FILTERED` had
 *  deliberately removed. A datastore beside a project has no business reaching
 *  the internet anyway, so the strict choice is also the correct one.
 */

export const SERVICE_CONTAINER_PREFIX = "rc-svc-";
const SERVICE_VOLUME_PREFIX = "rc-svcdata-";
const SERVICE_NETWORK_PREFIX = "rc-svcnet-";

/** What one declared service is doing right now. */
export interface ComposeServiceState {
  name: string;
  image: string;
  /** "running" | "stopped" | "absent" | "refused" */
  status: "running" | "stopped" | "absent" | "refused";
  /** Why it will not be started, when it will not be. */
  refusal: string | null;
  /** Container ports, for the editor to say where to connect. */
  ports: number[];
}

export interface ComposeStatus {
  /** Null when the project has no compose file at all. */
  project: ComposeProject | null;
  /** A file that could not be read. The project's own container still starts —
   *  being locked out of a project by a file you are trying to fix is the
   *  worst possible failure here — but the reason has to reach the user. */
  error: string | null;
  /** Whether this deployment runs compose services at all. When false the
   *  file is still read and reported, so the settings panel can say what
   *  WOULD happen rather than nothing. */
  enabled: boolean;
  services: ComposeServiceState[];
}

export function serviceContainerName(projectId: string, service: string): string {
  return `${SERVICE_CONTAINER_PREFIX}${projectId}-${service}`;
}

function serviceVolumeName(projectId: string, volume: string): string {
  return `${SERVICE_VOLUME_PREFIX}${projectId}-${volume}`;
}

export function serviceNetworkName(projectId: string): string {
  return `${SERVICE_NETWORK_PREFIX}${projectId}`;
}

/** Why a declared service will not be started, or null if it will be.
 *
 *  Separated from the parser because these are deployment decisions rather
 *  than facts about the file: the same `docker-compose.yml` is fine on one
 *  host and refused on another, and the message has to say which.
 */
export function refusalFor(
  service: ComposeService,
  index: number,
): string | null {
  if (!imageAllowed(service.image, env.COMPOSE_IMAGE_ALLOWLIST)) {
    return (
      `The image "${service.image}" is not on this deployment's allowlist, ` +
      "so it is not started. COMPOSE_IMAGE_ALLOWLIST decides what may run here."
    );
  }

  if (index >= env.COMPOSE_MAX_SERVICES) {
    return (
      `This deployment starts at most ${String(env.COMPOSE_MAX_SERVICES)} ` +
      "services per project, and this one is past that."
    );
  }

  return null;
}

/** The per-project network, created if it is not there.
 *
 *  Internal, always. See the note at the top of this file: the project's own
 *  container joins this as a SECOND network, and a routable second network is
 *  a hole straight through `SANDBOX_EGRESS_FILTERED`.
 */
async function ensureServiceNetwork(projectId: string): Promise<void> {
  const name = serviceNetworkName(projectId);
  const existing = await docker
    .listNetworks({ filters: { name: [name] } })
    .catch(() => []);

  if (existing.some((network) => network.Name === name)) return;

  await docker.createNetwork({
    Name: name,
    Driver: "bridge",
    Internal: true,
    Labels: { "rc.projectId": projectId },
  });
}

/** Puts the project's own container on the services' network too.
 *
 *  Idempotent: a container that is already connected answers with a 403 that
 *  says so, and reconnecting on every start is the ordinary case because a
 *  container is reused across starts.
 */
export async function attachProjectContainer(
  projectId: string,
  containerId: string,
): Promise<void> {
  await docker
    .getNetwork(serviceNetworkName(projectId))
    .connect({ Container: containerId })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (/already exists|already connected/i.test(message)) return;
      throw error;
    });
}

async function findServiceContainer(projectId: string, service: string) {
  const name = serviceContainerName(projectId, service);
  const containers = await docker
    .listContainers({ all: true, filters: { name: [name] } })
    .catch(() => []);

  const match = containers.find((info) =>
    info.Names.some((each) => each === `/${name}`),
  );
  return match ?? null;
}

async function startOne(
  projectId: string,
  service: ComposeService,
): Promise<void> {
  const existing = await findServiceContainer(projectId, service.name);

  if (existing) {
    if (existing.State === "running") return;
    await docker.getContainer(existing.Id).start();
    return;
  }

  for (const mount of service.volumes) {
    await docker
      .createVolume({ Name: serviceVolumeName(projectId, mount.volume) })
      .catch(() => undefined);
  }

  const container = await docker.createContainer({
    Image: service.image,
    name: serviceContainerName(projectId, service.name),
    // From the file, never from this process's own environment: a bare `KEY`
    // in a compose file asks for the host's value, and the host here is the
    // platform's server. See `parseEnvironment`.
    Env: Object.entries(service.env).map(([key, value]) => `${key}=${value}`),
    ...(service.command ? { Cmd: service.command } : {}),
    Labels: { "rc.projectId": projectId, "rc.service": service.name },
    HostConfig: {
      NetworkMode: serviceNetworkName(projectId),
      Binds: service.volumes.map(
        (mount) => `${serviceVolumeName(projectId, mount.volume)}:${mount.target}`,
      ),
      // Nothing is published to the host. The only thing that needs to reach
      // this is the project's own container, which is on the same network.
      Memory: env.COMPOSE_SERVICE_MEMORY_MB * 1024 * 1024,
      MemorySwap: env.COMPOSE_SERVICE_MEMORY_MB * 1024 * 1024,
      PidsLimit: 256,
      Init: true,
      // Drop everything, then add back the five an ordinary datastore
      // entrypoint cannot start without. **Found by running it, not by
      // reading it**: with a bare `CapDrop: ["ALL"]` the tests below passed
      // and the feature did not work at all -- `postgres:17-alpine` exits 1
      // with "failed switching to 'postgres': operation not permitted" and
      // `redis:7-alpine` exits 127 with "setpriv: setresuid failed", because
      // both images start as root, prepare their data directory, and drop to
      // their own user. That needs CHOWN, DAC_OVERRIDE and FOWNER for the
      // directory and SETGID/SETUID for the switch.
      //
      // Still far tighter than Docker's default set, and the omissions are
      // the interesting half: no NET_RAW, no MKNOD, no SYS_CHROOT, no
      // SETFCAP, no SETPCAP, no AUDIT_WRITE -- and no NET_BIND_SERVICE, so a
      // service here cannot take a privileged port. `no-new-privileges` stays,
      // which is the one that matters: these five are what the entrypoint is
      // GIVEN, and it can gain nothing beyond them from a setuid binary.
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      SecurityOpt: ["no-new-privileges"],
      // Stopped with the project rather than restarted forever by the daemon.
      RestartPolicy: { Name: "no" },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        // The whole point: the app reaches it by the name the file gave it,
        // which is what makes an unmodified repository work.
        [serviceNetworkName(projectId)]: { Aliases: [service.name] },
      },
    },
  });

  await container.start();
  increment("compose_services_started");
  logger.info("compose service started", {
    projectId,
    service: service.name,
    image: service.image,
  });
}

/** Starts every service a project declares that this deployment will run.
 *
 *  Never throws at the caller. A compose file is a file in a repository the
 *  platform did not write, and a bad one must not be able to hold a project
 *  closed — the same rule `runLifecycle` and `runDotfiles` already follow.
 *  What went wrong is reported through `describeServices`, which is where the
 *  user looks.
 */
export async function startServices(
  projectId: string,
  projectContainerId: string,
): Promise<void> {
  if (!env.COMPOSE_SERVICES_ENABLED) return;

  let project: ComposeProject | null;
  try {
    project = await readCompose(projectId);
  } catch (error) {
    if (error instanceof ComposeError) {
      logger.warn("compose file could not be read", {
        projectId,
        detail: error.message,
      });
      return;
    }
    throw error;
  }

  if (!project || project.services.length === 0) return;

  await ensureServiceNetwork(projectId);
  await attachProjectContainer(projectId, projectContainerId);

  for (const [index, service] of project.services.entries()) {
    if (refusalFor(service, index) !== null) continue;

    try {
      await startOne(projectId, service);
    } catch (error) {
      increment("compose_services_failed");
      logger.warn("compose service did not start", {
        projectId,
        service: service.name,
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

/** Every service container this project has, running or not.
 *
 *  Both filters, deliberately. The label is what identifies the project, and
 *  the name prefix is what keeps this from ever matching something that is not
 *  a compose service — the label is this file's own and nothing else sets it
 *  today, which is exactly the kind of fact that stops being true quietly.
 */
async function serviceContainers(projectId: string) {
  const containers = await docker
    .listContainers({
      all: true,
      filters: {
        label: [`rc.projectId=${projectId}`],
        name: [SERVICE_CONTAINER_PREFIX],
      },
    })
    .catch(() => []);

  return containers.filter((info) =>
    info.Names.some((name) =>
      name.startsWith(`/${serviceContainerName(projectId, "")}`),
    ),
  );
}

/** Stops the services, keeping their volumes and their data.
 *
 *  Called when the project's container is stopped or reaped, so an idle
 *  project costs nothing rather than half of nothing — which is the sentence
 *  §6 decision 4 already used about the managed database.
 */
export async function stopServices(projectId: string): Promise<void> {
  for (const info of await serviceContainers(projectId)) {
    await docker
      .getContainer(info.Id)
      .stop({ t: 5 })
      .catch(() => undefined);
  }
}

/** Removes the containers and the network, and **keeps the volumes**.
 *
 *  The split is deliberate and was got wrong first. `removeContainer` is what
 *  putting a project in the TRASH reaches, and `projectService` states the rule
 *  outright: *"Held: the tree, the row, the managed database's volume.
 *  Restoring is worthless without the data."* A compose file's `pgdata` is that
 *  same data, so trashing a project must not destroy it — the containers and
 *  the network are rebuilt from the file in seconds, and the volume is the only
 *  part of this that cannot be.
 *
 *  `destroyServices` below is the purge's job, and mirrors
 *  `managedDatabaseService.stop` / `.destroy` exactly.
 */
export async function removeServices(projectId: string): Promise<void> {
  for (const info of await serviceContainers(projectId)) {
    const container = docker.getContainer(info.Id);
    await container.stop({ t: 2 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
  }

  await docker
    .getNetwork(serviceNetworkName(projectId))
    .remove()
    .catch(() => undefined);
}

/** The containers, the network, and the volumes with them.
 *
 *  The volumes go here and nowhere else. `deployService.unpublish` learned
 *  this lesson about published files outliving the row that pointed at them,
 *  and `managedDatabaseService.destroy` learned it again with more disk
 *  attached; a compose file declaring four of them is the third time.
 */
export async function destroyServices(projectId: string): Promise<void> {
  await removeServices(projectId);

  const volumes = await docker
    .listVolumes({ filters: { name: [`${SERVICE_VOLUME_PREFIX}${projectId}-`] } })
    .catch(() => ({ Volumes: [] as { Name: string }[] }));

  for (const volume of volumes.Volumes ?? []) {
    // A prefix filter is a substring match in the daemon, so the exact prefix
    // is checked here: `rc-svcdata-<a>-db` must not be removed by a sweep for
    // a project whose id merely contains that one's.
    if (!volume.Name.startsWith(`${SERVICE_VOLUME_PREFIX}${projectId}-`)) continue;
    await docker.getVolume(volume.Name).remove({ force: true }).catch(() => undefined);
  }
}

/** What the file asked for and what is actually running.
 *
 *  Reads the file every time rather than caching: the user edits it in the
 *  editor beside this panel, and a cached answer is exactly the wrong one at
 *  the moment somebody is trying to fix it.
 */
export async function describeServices(projectId: string): Promise<ComposeStatus> {
  let project: ComposeProject | null = null;
  let error: string | null = null;

  try {
    project = await readCompose(projectId);
  } catch (problem) {
    if (!(problem instanceof ComposeError)) throw problem;
    error = problem.message;
  }

  const status: ComposeStatus = {
    project,
    error,
    enabled: env.COMPOSE_SERVICES_ENABLED,
    services: [],
  };

  if (!project) return status;

  const running = new Map(
    (await serviceContainers(projectId)).map((info) => [
      info.Labels["rc.service"] ?? "",
      info.State,
    ]),
  );

  status.services = project.services.map((service, index) => {
    const refusal = refusalFor(service, index);
    const state = running.get(service.name);

    return {
      name: service.name,
      image: service.image,
      status: refusal
        ? ("refused" as const)
        : state === "running"
          ? ("running" as const)
          : state
            ? ("stopped" as const)
            : ("absent" as const),
      refusal,
      ports: service.ports,
    };
  });

  return status;
}

/** Service containers whose project is gone, and the networks behind them.
 *
 *  A crash or a `docker kill` leaves these exactly as it leaves project
 *  containers, and `reconcileOnBoot` has swept those since it was written.
 *  Without this, a compose file's services would be the one thing on the host
 *  that nothing ever cleans up.
 */
export async function reconcileServices(known: Set<string>): Promise<number> {
  const containers = await docker
    .listContainers({ all: true, filters: { name: [SERVICE_CONTAINER_PREFIX] } })
    .catch(() => []);

  const orphans = new Set<string>();

  for (const info of containers) {
    const projectId = info.Labels["rc.projectId"];
    if (!projectId || known.has(projectId)) continue;
    orphans.add(projectId);
  }

  for (const projectId of orphans) {
    // Destroy, not remove: the project row does not exist, so there is nothing
    // left that could ever be restored and the volume is pure orphaned disk.
    await destroyServices(projectId);
  }

  return orphans.size;
}
