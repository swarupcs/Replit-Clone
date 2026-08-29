import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the deployment panel says about a service that is no longer running.
 *
 *  The row is written once, by a successful publish, and never again. Both
 *  defects these tests pin down come from reading it as though it were a
 *  live reading: a container that has crashed is still described as live, and
 *  the "app output" beneath it is still the thirty seconds captured at publish
 *  time. A user watching their published app fall over saw a green dot and a
 *  log of it starting up successfully.
 */

const findUnique = vi.fn();
const serviceTarget = vi.fn<() => Promise<string | undefined>>();
const serviceLogs = vi.fn<() => Promise<string>>();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: (args: unknown): unknown => findUnique(args) },
    deployment: { findMany: () => Promise.resolve([]) },
  },
}));

vi.mock("../containers/deployContainer.js", () => ({
  serviceTarget: (): unknown => serviceTarget(),
  serviceLogs: (): unknown => serviceLogs(),
  startService: vi.fn(),
  removeService: vi.fn(),
  waitForService: vi.fn(),
  runningServices: vi.fn(),
}));

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

/** A row as `publish` leaves it: LIVE, with the tail of a successful start. */
function serviceRow(overrides: Record<string, unknown> = {}) {
  return {
    subdomain: "quiet-fern-84f1",
    status: "LIVE",
    kind: "SERVICE",
    buildCommand: "npm install --omit=dev && node server.js",
    outputDir: "",
    port: 3000,
    sizeBytes: 4096,
    log: "listening on 3000",
    error: null,
    deployedAt: new Date("2026-08-20T10:00:00.000Z"),
    ...overrides,
  };
}

function projectWith(deployment: unknown): void {
  findUnique.mockResolvedValue({
    id: PROJECT,
    template: "node-express",
    deployment,
  });
}

let service: typeof import("./deployService.js");

beforeEach(async () => {
  vi.clearAllMocks();
  serviceTarget.mockResolvedValue("http://172.18.0.4:3000");
  serviceLogs.mockResolvedValue("");
  service = await import("./deployService.js");
});

describe("a published service that has stopped answering", () => {
  it("is not reported as live", async () => {
    // Docker restarts a crashed service ten times and then leaves it dead.
    // From that moment the public address answers 503 -- and the owner, the
    // one person who could fix the app, was told nothing was wrong.
    serviceTarget.mockResolvedValue(undefined);
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.status).toBe("failed");
    expect(state.deployment?.error).toMatch(/not answering/);
  });

  it("is reported as live while it is still answering", async () => {
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.status).toBe("live");
    expect(state.deployment?.error).toBeNull();
  });

  it("keeps the row's own status when Docker cannot be reached", async () => {
    // A daemon that is unreachable is a reason to show the row as it stands,
    // not a reason for the panel to fail to load or to accuse a working app
    // of being down.
    serviceTarget.mockRejectedValue(new Error("connect ENOENT"));
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.status).toBe("live");
  });

  it("leaves a static deployment alone", async () => {
    // There is no container behind one, so there is nothing to disagree with.
    serviceTarget.mockResolvedValue(undefined);
    projectWith(serviceRow({ kind: "STATIC", port: null }));

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.status).toBe("live");
    expect(serviceTarget).not.toHaveBeenCalled();
  });

  it("leaves a row that already failed alone", async () => {
    serviceTarget.mockResolvedValue(undefined);
    projectWith(serviceRow({ status: "FAILED", error: "build failed" }));

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.error).toBe("build failed");
    expect(serviceTarget).not.toHaveBeenCalled();
  });
});

describe("what a published service's log shows", () => {
  it("shows what it is printing now, not what it printed at publish time", async () => {
    // `deployment.log` is the tail captured during publish and never changes.
    // A service up for a week showed its first thirty seconds -- the half of
    // its output least likely to explain anything.
    serviceLogs.mockResolvedValue("GET /api/items 200\nGET /api/items 500");
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.log).toContain("500");
    expect(state.deployment?.log).not.toContain("listening on 3000");
  });

  it("shows the crash before the panel goes red", async () => {
    // The two halves are one answer: the status says it is down, the log says
    // why. Reporting the failure with a week-old startup log underneath would
    // be a worse lie than the green dot.
    serviceTarget.mockResolvedValue(undefined);
    serviceLogs.mockResolvedValue("Error: connect ECONNREFUSED 5432");
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.status).toBe("failed");
    expect(state.deployment?.log).toContain("ECONNREFUSED");
  });

  it("keeps the publish-time tail when there is no container to ask", async () => {
    // Blanking the panel would throw away the last thing anyone did see.
    serviceTarget.mockResolvedValue(undefined);
    serviceLogs.mockResolvedValue("");
    projectWith(serviceRow());

    const state = await service.deploymentState(PROJECT);

    expect(state.deployment?.log).toBe("listening on 3000");
  });
});
