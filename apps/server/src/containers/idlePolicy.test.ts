import { beforeEach, describe, expect, it, vi } from "vitest";

/** Who gets stopped for being idle, and what happens when the machine is full.
 *
 *  The two halves are one decision and are tested together on purpose. Making
 *  idleness optional without the capacity half does not give a user a
 *  long-lived container; it gives them a third project they can open and a
 *  fourth they cannot.
 */

const listContainers = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const createContainer = vi.hoisted(() => vi.fn());
const startContainer = vi.hoisted(() => vi.fn());

vi.mock("dockerode", () => ({
  default: class {
    listContainers = listContainers;
    createContainer = createContainer;
    getContainer = (id: string) => ({
      id,
      stop,
      start: startContainer,
      inspect: () => Promise.resolve({}),
      remove: () => Promise.resolve(),
    });
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

const resolveEntitlements = vi.hoisted(() => vi.fn());
vi.mock("../service/entitlementService.js", () => ({ resolveEntitlements }));

vi.mock("../utils/projectPaths.js", async () => ({
  ...(await vi.importActual<typeof import("../utils/projectPaths.js")>(
    "../utils/projectPaths.js",
  )),
  claimProjectForSandbox: () => Promise.resolve(),
  containerUser: () => Promise.resolve("1000:1000"),
  projectRoot: (id: string) => `/srv/projects/${id}`,
}));

import {
  ensureContainer,
  attach,
  detach,
  setOnProjectReaped,
  startIdleReaper,
  stopAllContainers,
} from "./containerManager.js";

const OPENING = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const RECENT = "33333333-3333-4333-8333-333333333333";
const THIRD = "44444444-4444-4444-8444-444444444444";
/** The reaper tests get an id of their own. `lastActiveAt` is module state
 *  that outlives a test, so a project the capacity tests touched would count
 *  as active here and never be old enough to stop. */
const UNTOUCHED = "55555555-5555-4555-8555-555555555555";

/** Containers as Docker lists them. `Created` is in seconds and is the clock
 *  the reclaim falls back to for a project nothing has marked active. */
function running(ids: string[]) {
  return ids.map((id, index) => ({
    Id: `c-${id}`,
    State: "running",
    Names: [`/rc-project-${id}`],
    Created: 1_000 + index,
  }));
}

/** Three, which is MAX_CONCURRENT_CONTAINERS in the test environment, so the
 *  project being opened arrives at a full machine. */
function full() {
  listContainers.mockResolvedValue(running([OLD, RECENT, THIRD]));
}

const reaped = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  findUnique.mockResolvedValue({
    id: OPENING,
    template: "node-express-ts",
    ownerId: "u1",
  });
  resolveEntitlements.mockResolvedValue({
    maxContainersPerUser: 0,
    idleMinutes: 20,
  });
  createContainer.mockResolvedValue({ id: "new", start: startContainer });
  stop.mockResolvedValue(undefined);
  reaped.mockResolvedValue(undefined);
  setOnProjectReaped(reaped);
});

describe("what the machine does when it is full", () => {
  /** Without this the personal plan is not usable. It never stops anything on
   *  a timer, so the third project a user opened would be the last one they
   *  could open until they restarted the server. */
  it("takes back a container nobody is watching rather than refusing", async () => {
    full();

    await expect(ensureContainer(OPENING)).resolves.toBeDefined();
    expect(stop).toHaveBeenCalled();
  });

  /** The reclaimed project's database goes with it, through the same handler
   *  the timer uses. Otherwise the slot freed is half the size of the one
   *  being taken, and the machine is still full. */
  it("takes the reclaimed project's database with it", async () => {
    full();

    await ensureContainer(OPENING);

    expect(reaped).toHaveBeenCalledWith(OLD);
  });

  /** The containers competing for the last slot are all somebody's work. The
   *  one touched longest ago is the one whose owner is least likely to be in
   *  the middle of something. */
  it("reclaims the least recently used, not the first it finds", async () => {
    full();
    // Touched now, so it is the newest by `lastActiveAt` rather than by
    // `Created` — which is the ordering that matters.
    attach(OLD);
    detach(OLD);

    await ensureContainer(OPENING);

    expect(reaped).toHaveBeenCalledWith(RECENT);
    expect(reaped).not.toHaveBeenCalledWith(OLD);
  });

  /** Attachments are never overridden. Stopping a container somebody has a
   *  terminal open on would take one person's running work to give another a
   *  slot, which is worse than an honest refusal. */
  it("refuses rather than stopping something somebody is watching", async () => {
    full();
    attach(OLD);
    attach(RECENT);
    attach(THIRD);

    await expect(ensureContainer(OPENING)).rejects.toThrow(/capacity/i);
    expect(stop).not.toHaveBeenCalled();

    detach(OLD);
    detach(RECENT);
    detach(THIRD);
  });

  /** A rebuild for a changed signature arrives at capacity with its own
   *  container already counted. Reclaiming it would stop the very thing being
   *  started. */
  it("never reclaims the project it is making room for", async () => {
    listContainers.mockResolvedValue(running([OPENING, OLD, RECENT]));
    attach(OLD);
    attach(RECENT);

    await expect(ensureContainer(OPENING)).rejects.toThrow(/capacity/i);
    expect(reaped).not.toHaveBeenCalledWith(OPENING);

    detach(OLD);
    detach(RECENT);
  });
});

describe("the idle reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    findUnique.mockResolvedValue({ id: UNTOUCHED, ownerId: "u1" });
    // Nothing has marked it active, so the reaper falls back to `Created` —
    // 1970, which is idle by any allowance.
    listContainers.mockResolvedValue(running([UNTOUCHED]));
  });

  /** The plan's number, not the deployment's. An idle container is somebody
   *  else's memory, and where there is nobody else the editor should not be
   *  deciding that closing a tab means killing the dev server behind it. */
  it("leaves a container alone when the owner's plan says never", async () => {
    resolveEntitlements.mockResolvedValue({
      maxContainersPerUser: 0,
      idleMinutes: 0,
    });

    startIdleReaper();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(reaped).not.toHaveBeenCalled();
    await stopAllContainers();
  });

  it("still stops one whose plan sets a limit", async () => {
    resolveEntitlements.mockResolvedValue({
      maxContainersPerUser: 0,
      idleMinutes: 1,
    });

    startIdleReaper();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(reaped).toHaveBeenCalledWith(UNTOUCHED);
    await stopAllContainers();
  });

  /** A reaper that stopped reclaiming because Postgres was briefly
   *  unreachable would turn a database blip into the memory exhaustion it
   *  exists to prevent. The safe direction on failure is to stop things. */
  it("falls back to the deployment default when the plan cannot be read", async () => {
    resolveEntitlements.mockRejectedValue(new Error("no database"));

    startIdleReaper();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(reaped).toHaveBeenCalledWith(UNTOUCHED);
    await stopAllContainers();
  });
});
