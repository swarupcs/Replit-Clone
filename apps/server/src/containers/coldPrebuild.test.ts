import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  env: {
    PREBUILD_STOPPED: true,
    PREBUILD_MAX_COMMITTED: 0.6,
    PREBUILD_RECENT_DAYS: 7,
    PREBUILD_STOP_AFTER: true,
  },
}));
vi.mock("../config/env.js", () => envMock);
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/metrics.js", () => ({ increment: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  project: { findMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

const containers = vi.hoisted(() => ({
  ensureContainer: vi.fn(),
  runningProjectContainers: vi.fn(),
  stopContainer: vi.fn(),
}));
vi.mock("./containerManager.js", () => containers);

const sizes = vi.hoisted(() => ({ budgetMb: vi.fn(), committedMb: vi.fn() }));
vi.mock("../service/workspaceSizeService.js", () => sizes);

const prebuildMock = vi.hoisted(() => ({ prebuild: vi.fn() }));
vi.mock("./prebuild.js", () => prebuildMock);

const warm = vi.hoisted(() => ({ dependencyFingerprint: vi.fn() }));
vi.mock("./warmStart.js", () => warm);

import {
  coldPrebuild,
  hasHeadroom,
  prebuildCandidates,
  sweepColdPrebuilds,
} from "./coldPrebuild.js";

const A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  vi.clearAllMocks();
  envMock.env.PREBUILD_STOPPED = true;
  envMock.env.PREBUILD_MAX_COMMITTED = 0.6;
  envMock.env.PREBUILD_RECENT_DAYS = 7;
  envMock.env.PREBUILD_STOP_AFTER = true;

  sizes.budgetMb.mockResolvedValue(8000);
  sizes.committedMb.mockResolvedValue(1000);
  containers.runningProjectContainers.mockResolvedValue([]);
  containers.ensureContainer.mockResolvedValue({});
  containers.stopContainer.mockResolvedValue(undefined);
  prismaMock.project.findMany.mockResolvedValue([{ id: A }]);
  prismaMock.project.findUnique.mockResolvedValue({ prebuiltFingerprint: "old" });
  warm.dependencyFingerprint.mockResolvedValue("new");
  prebuildMock.prebuild.mockResolvedValue(true);
});

describe("whether the host has room for work nobody asked for", () => {
  it("has room when little is committed", async () => {
    await expect(hasHeadroom()).resolves.toBe(true);
  });

  it("does not when the budget is mostly spent", async () => {
    // §12.5's first collision: this spends memory the capacity gate is
    // rationing, at a moment the host may want it for a workspace somebody is
    // actually opening.
    sizes.committedMb.mockResolvedValue(6000);
    await expect(hasHeadroom()).resolves.toBe(false);
  });

  it("measures memory, not a count of containers", async () => {
    // A count says nothing about a host running one large workspace.
    sizes.budgetMb.mockResolvedValue(2000);
    sizes.committedMb.mockResolvedValue(1800);
    await expect(hasHeadroom()).resolves.toBe(false);
  });

  it("refuses rather than dividing by a budget of zero", async () => {
    sizes.budgetMb.mockResolvedValue(0);
    await expect(hasHeadroom()).resolves.toBe(false);
  });
});

describe("which workspaces are worth building", () => {
  it("asks only for ones opened recently", async () => {
    await prebuildCandidates([]);

    const where = prismaMock.project.findMany.mock.calls[0]?.[0] as {
      where: { updatedAt?: { gte: Date }; deletedAt: null };
    };
    // A prebuild is only worth its memory if it is spent shortly before
    // somebody arrives.
    expect(where.where.updatedAt?.gte).toBeInstanceOf(Date);
    expect(where.where.deletedAt).toBeNull();
  });

  it("drops the recency filter when it is set to zero", async () => {
    envMock.env.PREBUILD_RECENT_DAYS = 0;
    await prebuildCandidates([]);

    const where = prismaMock.project.findMany.mock.calls[0]?.[0] as {
      where: { updatedAt?: unknown };
    };
    expect(where.where.updatedAt).toBeUndefined();
  });

  it("skips the ones already running, which are §12.2's", async () => {
    await prebuildCandidates([A]);

    const where = prismaMock.project.findMany.mock.calls[0]?.[0] as {
      where: { id: { notIn: string[] } };
    };
    expect(where.where.id.notIn).toEqual([A]);
  });

  it("caps how many it will consider", async () => {
    // The gates stop the sweep mid-way anyway, but a query that could return
    // every project on a large deployment is one somebody will regret.
    await prebuildCandidates([]);
    const call = prismaMock.project.findMany.mock.calls[0]?.[0] as { take: number };
    expect(call.take).toBeLessThanOrEqual(50);
  });
});

describe("building one", () => {
  it("starts it, builds it, and puts it back", async () => {
    await expect(coldPrebuild(A)).resolves.toBe(true);

    expect(containers.ensureContainer).toHaveBeenCalledWith(A);
    // §12.5's sharpest objection: on a plan whose workspaces never sleep,
    // leaving this running silently converts a stopped workspace into a
    // running one -- a change to what the machine COSTS.
    expect(containers.stopContainer).toHaveBeenCalledWith(A);
  });

  it("stops it even when the build failed", async () => {
    prebuildMock.prebuild.mockRejectedValue(new Error("install died"));
    await expect(coldPrebuild(A)).resolves.toBe(false);
    expect(containers.stopContainer).toHaveBeenCalledWith(A);
  });

  it("leaves running a workspace somebody opened while it was deciding", async () => {
    containers.runningProjectContainers.mockResolvedValue([A]);

    await expect(coldPrebuild(A)).resolves.toBe(false);
    // Only what this started gets stopped. Stopping somebody's open workspace
    // would be far worse than never prebuilding at all.
    expect(containers.stopContainer).not.toHaveBeenCalled();
    expect(containers.ensureContainer).not.toHaveBeenCalled();
  });

  it("starts nothing when the install is already current", async () => {
    // The whole point of the host-side fingerprint: deciding this without it
    // would mean starting every workspace to find out.
    prismaMock.project.findUnique.mockResolvedValue({ prebuiltFingerprint: "new" });

    await expect(coldPrebuild(A)).resolves.toBe(false);
    expect(containers.ensureContainer).not.toHaveBeenCalled();
  });

  it("starts nothing for a project with no dependency files", async () => {
    warm.dependencyFingerprint.mockResolvedValue(null);
    await expect(coldPrebuild(A)).resolves.toBe(false);
    expect(containers.ensureContainer).not.toHaveBeenCalled();
  });

  it("leaves it running when an operator asked for that", async () => {
    envMock.env.PREBUILD_STOP_AFTER = false;
    await coldPrebuild(A);
    expect(containers.stopContainer).not.toHaveBeenCalled();
  });

  it("says nothing to anybody when it fails", async () => {
    // §12.2's rule, one step further: nobody asked for this work, so a
    // notification about it failing converts a saved minute into an
    // interruption.
    containers.ensureContainer.mockRejectedValue(new Error("no room"));
    await expect(coldPrebuild(A)).resolves.toBe(false);
  });
});

describe("the sweep", () => {
  it("does nothing at all when it is off", async () => {
    envMock.env.PREBUILD_STOPPED = false;
    await expect(sweepColdPrebuilds()).resolves.toBe(0);
    expect(prismaMock.project.findMany).not.toHaveBeenCalled();
  });

  it("does nothing when the host is busy", async () => {
    sizes.committedMb.mockResolvedValue(7000);
    await expect(sweepColdPrebuilds()).resolves.toBe(0);
    expect(containers.ensureContainer).not.toHaveBeenCalled();
  });

  it("re-checks headroom between workspaces", async () => {
    prismaMock.project.findMany.mockResolvedValue([{ id: A }, { id: "second" }]);
    // Quiet for the sweep's own check and the first workspace, busy after.
    sizes.committedMb
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(1000)
      .mockResolvedValue(7000);

    await sweepColdPrebuilds();

    // A sweep that decided the host was quiet ten minutes ago is not evidence
    // about the host now, and the premise is that this yields to real work.
    expect(containers.ensureContainer).toHaveBeenCalledTimes(1);
  });

  it("counts what it built", async () => {
    await expect(sweepColdPrebuilds()).resolves.toBe(1);
  });
});
