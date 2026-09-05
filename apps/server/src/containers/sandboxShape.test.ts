import { beforeEach, describe, expect, it, vi } from "vitest";

/** The shape of the container a project actually gets.
 *
 *  `envSignature.test.ts` covers WHEN a container is rebuilt. This covers what
 *  is built — the properties of `createContainer` that are load-bearing and
 *  invisible: nothing here shows up in a passing dev loop, and each one is only
 *  noticed by the failure it was there to prevent.
 */

const createContainer = vi.hoisted(() => vi.fn());
const listContainers = vi.hoisted(() => vi.fn());
const getContainer = vi.hoisted(() => vi.fn());

vi.mock("dockerode", () => ({
  default: class {
    createContainer = createContainer;
    listContainers = listContainers;
    getContainer = getContainer;
    getVolume = () => ({ inspect: () => Promise.resolve({}) });
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({
  increment: vi.fn(),
  registerGauge: vi.fn(),
}));
vi.mock("../service/projectEnvService.js", () => ({
  getEnvVars: () => Promise.resolve({}),
  toDockerEnv: () => [],
}));
vi.mock("./devcontainer.js", async () => ({
  ...(await vi.importActual<typeof import("./devcontainer.js")>(
    "./devcontainer.js",
  )),
  readDevcontainer: () => Promise.resolve(null),
}));
vi.mock("./sandboxNetwork.js", () => ({
  SANDBOX_NETWORK: "replit-clone-sandbox",
  ensureNetwork: () => Promise.resolve(),
}));
vi.mock("./egressGateway.js", () => ({ proxyEnv: () => [] }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique, findMany: () => Promise.resolve([]) },
    user: { findUnique: () => Promise.resolve(null) },
  },
}));

/** The per-account share of the machine. Not what this file is about, and
 *  generous enough here that it never decides anything. */
vi.mock("../service/entitlementService.js", () => ({
  resolveEntitlements: () => Promise.resolve({ maxContainersPerUser: 0 }),
}));

vi.mock("../utils/projectPaths.js", async () => ({
  ...(await vi.importActual<typeof import("../utils/projectPaths.js")>(
    "../utils/projectPaths.js",
  )),
  claimProjectForSandbox: () => Promise.resolve(),
  containerUser: () => Promise.resolve("1000:1000"),
  projectRoot: (id: string) => `/srv/projects/${id}`,
}));

import { ensureContainer } from "./containerManager.js";

const PROJECT = "2fc94132-48c8-4316-b039-88e24409734b";

interface Created {
  HostConfig: Record<string, unknown>;
  Cmd: string[];
}

function created(): Created {
  const [options] = createContainer.mock.calls[0] as [Created];
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    id: PROJECT,
    template: "node-express-ts",
    ownerId: "u1",
  });
  // No container yet, and nothing else running: this is a cold start.
  listContainers.mockResolvedValue([]);
  createContainer.mockResolvedValue({
    id: "c1",
    start: () => Promise.resolve(),
  });
});

describe("the container a project is given", () => {
  /** The defect this was added for. `sleep infinity` was pid 1, and `sleep`
   *  does not reap — so every process orphaned inside the container was
   *  reparented to it and stayed there as a zombie until the container was
   *  removed. Orphaning is the ORDINARY case here, not an edge one: hanging a
   *  terminal up while its dev server is still running produces one every
   *  time. Each zombie holds a pid against `PidsLimit`, which is 256, so a
   *  project opened and closed enough times would eventually be unable to
   *  start any process at all. */
  it("runs an init as pid 1, so orphans are reaped", async () => {
    await ensureContainer(PROJECT);

    expect(created().HostConfig["Init"]).toBe(true);
  });

  /** The init is what makes this safe to keep. The container's own command has
   *  to be something that never exits — terminals and the Run button attach
   *  with `docker exec` — and `sleep infinity` is that, now with something
   *  above it that does pid 1's other job. */
  it("still idles rather than running anything of its own", async () => {
    await ensureContainer(PROJECT);

    expect(created().Cmd).toEqual(["sleep", "infinity"]);
  });

  it("caps a fork bomb", async () => {
    await ensureContainer(PROJECT);

    expect(created().HostConfig["PidsLimit"]).toBe(256);
  });

  it("holds no capabilities and cannot gain any", async () => {
    await ensureContainer(PROJECT);

    expect(created().HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(created().HostConfig["SecurityOpt"]).toEqual(["no-new-privileges"]);
  });

  /** Equal to Memory disables swap. Without that a container can evade its
   *  memory limit by swapping the host to death instead. */
  it("cannot swap its way past its memory limit", async () => {
    await ensureContainer(PROJECT);

    expect(created().HostConfig["MemorySwap"]).toBe(
      created().HostConfig["Memory"],
    );
  });

  /** Everything here is interactive: a container that dies does so in front of
   *  somebody who can act on it. Restarting it would hide that. */
  it("is not restarted behind the user's back", async () => {
    await ensureContainer(PROJECT);

    expect(created().HostConfig["RestartPolicy"]).toEqual({ Name: "no" });
  });
});
