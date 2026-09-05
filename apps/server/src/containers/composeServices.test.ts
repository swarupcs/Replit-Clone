import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Running the services a project's compose file declares. plan.md §11.3.
 *
 *  Three things here are silent when wrong, and each has a test that fails if
 *  the guard is removed:
 *
 *  - **The network.** Two projects both declaring `postgres` on the shared
 *    sandbox network would share the alias, and Docker's DNS would round-robin
 *    between them — one project's app connecting to another project's database,
 *    intermittently. Every service goes on a network named for its project.
 *  - **`Internal: true` on that network.** The project's container joins it as
 *    a SECOND network, so a routable one would be a hole straight through
 *    SANDBOX_EGRESS_FILTERED.
 *  - **The posture.** These are images named by a repository, so they run under
 *    the same CapDrop/no-new-privileges/PidsLimit every sandbox does.
 */

const docker = vi.hoisted(() => ({
  createContainer: vi.fn(),
  getContainer: vi.fn(),
  listContainers: vi.fn(),
  listNetworks: vi.fn(),
  createNetwork: vi.fn(),
  getNetwork: vi.fn(),
  createVolume: vi.fn(),
  listVolumes: vi.fn(),
  getVolume: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    createContainer = docker.createContainer;
    getContainer = docker.getContainer;
    listContainers = docker.listContainers;
    listNetworks = docker.listNetworks;
    createNetwork = docker.createNetwork;
    getNetwork = docker.getNetwork;
    createVolume = docker.createVolume;
    listVolumes = docker.listVolumes;
    getVolume = docker.getVolume;
  },
}));

const settings = vi.hoisted(() => ({
  COMPOSE_SERVICES_ENABLED: true,
  COMPOSE_IMAGE_ALLOWLIST: ["postgres:*", "redis:*"],
  COMPOSE_MAX_SERVICES: 4,
  COMPOSE_SERVICE_MEMORY_MB: 512,
}));

vi.mock("../config/env.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: settings,
}));

const compose = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("./composeFile.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCompose: compose.read,
}));

const {
  describeServices,
  reconcileServices,
  refusalFor,
  destroyServices,
  removeServices,
  serviceContainerName,
  serviceNetworkName,
  startServices,
  stopServices,
} = await import("./composeServices.js");

const PROJECT = "11111111-2222-4333-8444-555555555555";

function service(patch: Partial<Record<string, unknown>> = {}) {
  return {
    name: "db",
    image: "postgres:17-alpine",
    env: {},
    volumes: [],
    ports: [5432],
    ...patch,
  };
}

function project(services: unknown[]) {
  return {
    source: "docker-compose.yml",
    services,
    appService: "app",
    unsupported: [],
  };
}

beforeEach(() => {
  for (const fn of Object.values(docker)) fn.mockReset();
  compose.read.mockReset();

  settings.COMPOSE_SERVICES_ENABLED = true;
  settings.COMPOSE_IMAGE_ALLOWLIST = ["postgres:*", "redis:*"];
  settings.COMPOSE_MAX_SERVICES = 4;

  docker.listContainers.mockResolvedValue([]);
  docker.listNetworks.mockResolvedValue([]);
  docker.createNetwork.mockResolvedValue({});
  docker.createVolume.mockResolvedValue({});
  docker.listVolumes.mockResolvedValue({ Volumes: [] });
  docker.getNetwork.mockReturnValue({
    connect: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
  });
  docker.createContainer.mockResolvedValue({
    id: "svc1",
    start: vi.fn().mockResolvedValue({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the network these run on", () => {
  /** The load-bearing decision in the module. */
  it("is named for the project, not shared", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Name: serviceNetworkName(PROJECT) }),
    );
    expect(serviceNetworkName(PROJECT)).toContain(PROJECT);
  });

  /** Not tidiness. The project's own container joins this as a second network,
   *  and a routable second network hands it the way off the host that
   *  SANDBOX_EGRESS_FILTERED had removed. */
  it("is internal, so joining it cannot restore egress", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(docker.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ Internal: true }),
    );
  });

  it("is created once, not on every start", async () => {
    docker.listNetworks.mockResolvedValue([{ Name: serviceNetworkName(PROJECT) }]);
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(docker.createNetwork).not.toHaveBeenCalled();
  });

  /** The whole point: the app reaches it by the name the file gave it, which
   *  is what makes an unmodified repository work. */
  it("gives the service the alias its own file named it", async () => {
    compose.read.mockResolvedValue(project([service({ name: "cache", image: "redis:7" })]));

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as {
      NetworkingConfig: { EndpointsConfig: Record<string, { Aliases: string[] }> };
    };
    expect(
      created.NetworkingConfig.EndpointsConfig[serviceNetworkName(PROJECT)]?.Aliases,
    ).toEqual(["cache"]);
  });

  it("joins the project's own container to it", async () => {
    const connect = vi.fn().mockResolvedValue({});
    docker.getNetwork.mockReturnValue({ connect, remove: vi.fn() });
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(connect).toHaveBeenCalledWith({ Container: "app-container" });
  });

  /** A container is reused across starts, so this runs again every time and
   *  must not throw when it has already happened. */
  it("survives the container already being connected", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("endpoint already exists"));
    docker.getNetwork.mockReturnValue({ connect, remove: vi.fn() });
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(docker.createContainer).toHaveBeenCalled();
  });
});

describe("the container it makes", () => {
  /** **This test was written after running it, and would have been wrong
   *  before.** A bare `CapDrop: ["ALL"]` passes every other assertion in this
   *  file and makes the feature completely non-functional: `postgres` exits 1
   *  and `redis` exits 127, because both start as root and drop to their own
   *  user. The five added back are what that needs and nothing more -- the
   *  omissions matter as much as the additions, so they are pinned too. */
  it("adds back exactly the capabilities a datastore entrypoint needs", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as {
      HostConfig: { CapAdd: string[] };
    };
    expect(created.HostConfig.CapAdd).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "SETGID",
      "SETUID",
    ]);
    // Not in Docker's default set either way, and each would give a service
    // something it has no use for. NET_BIND_SERVICE is the one worth naming:
    // without it nothing here can take a privileged port.
    for (const capability of [
      "NET_RAW",
      "NET_BIND_SERVICE",
      "MKNOD",
      "SYS_CHROOT",
      "SETFCAP",
      "SETPCAP",
      "AUDIT_WRITE",
    ]) {
      expect(created.HostConfig.CapAdd).not.toContain(capability);
    }
  });

  it("runs under the same posture every sandbox does", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as {
      HostConfig: Record<string, unknown>;
    };
    expect(created.HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(created.HostConfig["SecurityOpt"]).toEqual(["no-new-privileges"]);
    expect(created.HostConfig["PidsLimit"]).toBe(256);
    expect(created.HostConfig["Init"]).toBe(true);
    expect(created.HostConfig["Memory"]).toBe(512 * 1024 * 1024);
  });

  /** Nothing is published to the host, exactly as project and database
   *  containers publish nothing. The only thing that needs to reach this is on
   *  the same private network. */
  it("publishes nothing to the host", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created["ExposedPorts"]).toBeUndefined();
    expect((created["HostConfig"] as Record<string, unknown>)["PortBindings"]).toBeUndefined();
  });

  /** The daemon must not restart these on its own: they are stopped with the
   *  project, and `unless-stopped` would bring a reaped project's Postgres
   *  back on the next daemon restart with nothing to stop it again. */
  it("is not restarted by the daemon", async () => {
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as {
      HostConfig: { RestartPolicy: { Name: string } };
    };
    expect(created.HostConfig.RestartPolicy.Name).toBe("no");
  });

  /** Named volumes are namespaced by project, or two projects declaring
   *  `pgdata` would share one database's files. */
  it("namespaces a named volume to the project", async () => {
    compose.read.mockResolvedValue(
      project([service({ volumes: [{ volume: "pgdata", target: "/var/lib/postgresql/data" }] })]),
    );

    await startServices(PROJECT, "app-container");

    const created = docker.createContainer.mock.calls[0]?.[0] as {
      HostConfig: { Binds: string[] };
    };
    expect(created.HostConfig.Binds[0]).toBe(
      `rc-svcdata-${PROJECT}-pgdata:/var/lib/postgresql/data`,
    );
  });

  it("names the container for the project and the service", () => {
    expect(serviceContainerName(PROJECT, "db")).toBe(`rc-svc-${PROJECT}-db`);
  });
});

describe("what this deployment will and will not run", () => {
  it("refuses an image that is not on the allowlist", () => {
    expect(refusalFor(service({ image: "ubuntu:24.04" }) as never, 0)).toMatch(
      /not on this deployment's allowlist/,
    );
  });

  it("allows one that is", () => {
    expect(refusalFor(service() as never, 0)).toBeNull();
  });

  /** A compose file declaring twenty services would take the host on the first
   *  project that opened it. */
  it("refuses past the per-project cap", () => {
    expect(refusalFor(service() as never, 4)).toMatch(/at most 4/);
  });

  it("starts nothing when the deployment has it off", async () => {
    settings.COMPOSE_SERVICES_ENABLED = false;
    compose.read.mockResolvedValue(project([service()]));

    await startServices(PROJECT, "app-container");

    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("starts nothing for a project with no compose file", async () => {
    compose.read.mockResolvedValue(null);

    await startServices(PROJECT, "app-container");

    expect(docker.createNetwork).not.toHaveBeenCalled();
  });

  it("does not create a refused service", async () => {
    compose.read.mockResolvedValue(project([service({ image: "ubuntu:24.04" })]));

    await startServices(PROJECT, "app-container");

    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});

describe("a file this platform cannot use", () => {
  /** A compose file is a file in a repository this platform did not write, and
   *  a bad one must not be able to hold a project closed — the rule
   *  `runLifecycle` and `runDotfiles` already follow. */
  it("does not stop the project from starting", async () => {
    const { ComposeError } = await import("./composeFile.js");
    compose.read.mockRejectedValue(new ComposeError("not valid YAML"));

    await expect(startServices(PROJECT, "app-container")).resolves.toBeUndefined();
  });

  /** ...and a service that will not start does not stop the ones after it. */
  it("carries on past a service that fails to start", async () => {
    compose.read.mockResolvedValue(
      project([service({ name: "db" }), service({ name: "cache", image: "redis:7" })]),
    );
    docker.createContainer
      .mockRejectedValueOnce(new Error("no such image"))
      .mockResolvedValue({ id: "svc2", start: vi.fn().mockResolvedValue({}) });

    await startServices(PROJECT, "app-container");

    expect(docker.createContainer).toHaveBeenCalledTimes(2);
  });
});

describe("stopping and removing", () => {
  const running = [
    {
      Id: "c1",
      Names: [`/rc-svc-${PROJECT}-db`],
      Labels: { "rc.projectId": PROJECT, "rc.service": "db" },
      State: "running",
    },
  ];

  it("stops the containers and keeps the data", async () => {
    docker.listContainers.mockResolvedValue(running);
    const stop = vi.fn().mockResolvedValue({});
    docker.getContainer.mockReturnValue({ stop, remove: vi.fn() });

    await stopServices(PROJECT);

    expect(stop).toHaveBeenCalled();
    expect(docker.getVolume).not.toHaveBeenCalled();
  });

  /** **The split this got wrong first, found by running it.**
   *  `removeContainer` is the path putting a project in the TRASH takes, and
   *  `projectService` states the rule outright: "Restoring is worthless
   *  without the data." A compose file's `pgdata` is that data. Containers and
   *  networks rebuild from the file in seconds; the volume does not. */
  it("keeps the volumes when a project is only trashed", async () => {
    docker.listContainers.mockResolvedValue(running);
    docker.getContainer.mockReturnValue({
      stop: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    });
    docker.listVolumes.mockResolvedValue({
      Volumes: [{ Name: `rc-svcdata-${PROJECT}-pgdata` }],
    });
    const removeVolume = vi.fn().mockResolvedValue({});
    docker.getVolume.mockReturnValue({ remove: removeVolume });
    docker.getNetwork.mockReturnValue({
      remove: vi.fn().mockResolvedValue({}),
      connect: vi.fn(),
    });

    await removeServices(PROJECT);

    expect(removeVolume).not.toHaveBeenCalled();
  });

  /** The volumes go with the PURGE. `deployService.unpublish` learned this
   *  about published files and `managedDatabaseService.destroy` learned it
   *  again with more disk attached. */
  it("removes the volumes and the network on a purge", async () => {
    docker.listContainers.mockResolvedValue(running);
    docker.getContainer.mockReturnValue({
      stop: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    });
    docker.listVolumes.mockResolvedValue({
      Volumes: [{ Name: `rc-svcdata-${PROJECT}-pgdata` }],
    });
    const removeVolume = vi.fn().mockResolvedValue({});
    docker.getVolume.mockReturnValue({ remove: removeVolume });
    const removeNetwork = vi.fn().mockResolvedValue({});
    docker.getNetwork.mockReturnValue({ remove: removeNetwork, connect: vi.fn() });

    await destroyServices(PROJECT);

    expect(removeVolume).toHaveBeenCalled();
    expect(removeNetwork).toHaveBeenCalled();
  });

  /** The daemon's name filter is a SUBSTRING match, so a sweep for one project
   *  can be handed another project's volume. */
  it("will not remove a volume belonging to a different project", async () => {
    docker.listContainers.mockResolvedValue([]);
    docker.listVolumes.mockResolvedValue({
      Volumes: [{ Name: "rc-svcdata-other-project-pgdata" }],
    });
    const removeVolume = vi.fn().mockResolvedValue({});
    docker.getVolume.mockReturnValue({ remove: removeVolume });

    await destroyServices(PROJECT);

    expect(removeVolume).not.toHaveBeenCalled();
  });
});

describe("the boot sweep", () => {
  /** A crash leaves these exactly as it leaves project containers — and
   *  nothing else on the host would ever clean them up, because they are not
   *  named `rc-project-`. */
  it("removes services whose project is gone", async () => {
    docker.listContainers.mockResolvedValue([
      {
        Id: "c1",
        Names: [`/rc-svc-${PROJECT}-db`],
        Labels: { "rc.projectId": PROJECT, "rc.service": "db" },
        State: "running",
      },
    ]);
    docker.getContainer.mockReturnValue({
      stop: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    });

    expect(await reconcileServices(new Set())).toBe(1);
  });

  it("leaves services whose project still exists", async () => {
    docker.listContainers.mockResolvedValue([
      {
        Id: "c1",
        Names: [`/rc-svc-${PROJECT}-db`],
        Labels: { "rc.projectId": PROJECT, "rc.service": "db" },
        State: "running",
      },
    ]);

    expect(await reconcileServices(new Set([PROJECT]))).toBe(0);
  });
});

describe("what the editor is told", () => {
  it("reports a service that is running", async () => {
    compose.read.mockResolvedValue(project([service()]));
    docker.listContainers.mockResolvedValue([
      {
        Id: "c1",
        Names: [`/rc-svc-${PROJECT}-db`],
        Labels: { "rc.projectId": PROJECT, "rc.service": "db" },
        State: "running",
      },
    ]);

    const status = await describeServices(PROJECT);

    expect(status.services[0]).toMatchObject({ name: "db", status: "running" });
  });

  it("reports one that is declared but not started", async () => {
    compose.read.mockResolvedValue(project([service()]));

    const status = await describeServices(PROJECT);

    expect(status.services[0]?.status).toBe("absent");
  });

  /** A refusal has to say why, or the panel reads as a bug. */
  it("reports a refusal with its reason", async () => {
    compose.read.mockResolvedValue(project([service({ image: "ubuntu:24.04" })]));

    const status = await describeServices(PROJECT);

    expect(status.services[0]?.status).toBe("refused");
    expect(status.services[0]?.refusal).toMatch(/allowlist/);
  });

  /** The file is still read when the deployment does not run services, so the
   *  panel can say what WOULD happen rather than nothing at all. */
  it("still describes the file when the deployment has it off", async () => {
    settings.COMPOSE_SERVICES_ENABLED = false;
    compose.read.mockResolvedValue(project([service()]));

    const status = await describeServices(PROJECT);

    expect(status.enabled).toBe(false);
    expect(status.services).toHaveLength(1);
  });

  it("reports a file that could not be read", async () => {
    const { ComposeError } = await import("./composeFile.js");
    compose.read.mockRejectedValue(new ComposeError("not valid YAML"));

    const status = await describeServices(PROJECT);

    expect(status.error).toBe("not valid YAML");
    expect(status.project).toBeNull();
  });
});
