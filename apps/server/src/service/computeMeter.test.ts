import { beforeEach, describe, expect, it, vi } from "vitest";

/** The meter for the thing this platform actually spends.
 *
 *  Disk and project count are limited and measured; container-hours are the
 *  real cost and were measured nowhere, so §8.8's question — does this product
 *  sell capability or sell minutes — had no data behind it at all.
 *
 *  Every test here is really about one decision: **sample, do not open a
 *  session.** A `startedAt`/`endedAt` row per container is the obvious shape
 *  and it is §2.26's restart wedge again — an open end, a process that stops
 *  existing, and a total wrong forever afterwards. A sweep loses at most one
 *  tick and fails by undercounting, which is the right direction for a number
 *  that might one day be a bill.
 */

const upsert = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const deploymentFindMany = vi.hoisted(() => vi.fn());
const usageFindMany = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    computeUsage: { upsert, findMany: usageFindMany },
    project: { findMany: projectFindMany },
    deployment: { findMany: deploymentFindMany },
  },
}));

const runningProjectContainers = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({ runningProjectContainers }));

const runningServices = vi.hoisted(() => vi.fn());
vi.mock("../containers/deployContainer.js", () => ({ runningServices }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  computeSecondsSince,
  resetComputeMeter,
  sampleCompute,
  startOfMonth,
} from "./computeMeterService.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const SECOND = "8f2e5c13-4b6a-4d92-9e07-1a3c6b8d5f42";

const T0 = new Date("2026-09-01T12:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

function amount(call = 0): number {
  return (upsert.mock.calls[call]?.[0] as { create: { seconds: number } }).create
    .seconds;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetComputeMeter();
  upsert.mockResolvedValue({});
  usageFindMany.mockResolvedValue([]);
  runningProjectContainers.mockResolvedValue([PROJECT]);
  runningServices.mockResolvedValue(new Set<string>());
  deploymentFindMany.mockResolvedValue([]);
  projectFindMany.mockResolvedValue([{ id: PROJECT, ownerId: OWNER }]);
});

describe("the first tick after boot", () => {
  /** There is nothing to measure from. Counting it as a full interval would
   *  attribute a minute nobody was here for — and a meter that invents usage
   *  at every restart is one that reads highest for the least stable host. */
  it("records nothing and only starts the clock", async () => {
    expect(await sampleCompute(T0)).toBe(0);
    expect(upsert).not.toHaveBeenCalled();

    expect(await sampleCompute(later(60_000))).toBe(60);
  });
});

describe("one tick", () => {
  beforeEach(async () => {
    await sampleCompute(T0);
  });

  it("counts the seconds that actually elapsed, not the interval", async () => {
    // A sweep that fires late has still been a late sweep, and pretending it
    // was punctual would lose the difference every time.
    await sampleCompute(later(90_000));

    expect(amount()).toBe(90);
  });

  /** A laptop that slept, a paused debugger, or a host that was simply busy
   *  all produce one enormous delta. The container may well have been running
   *  — but this process was not watching, and a meter that guesses upward is
   *  the one nobody can defend. */
  it("will not attribute a gap it did not observe", async () => {
    await sampleCompute(later(6 * 60 * 60 * 1000));

    expect(amount()).toBe(120);
  });

  it("writes to the day being counted, in UTC", async () => {
    await sampleCompute(later(60_000));

    const where = (upsert.mock.calls[0]?.[0] as {
      where: { userId_day: { userId: string; day: Date } };
    }).where;
    expect(where.userId_day.userId).toBe(OWNER);
    expect(where.userId_day.day.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("adds to the day rather than replacing it", async () => {
    await sampleCompute(later(60_000));

    // `set` here would make a day's total equal its last minute.
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { seconds: { increment: 60 } },
    });
  });
});

describe("what counts", () => {
  beforeEach(async () => {
    await sampleCompute(T0);
  });

  /** A project with a managed database runs two containers, and two is what
   *  it costs the host — the same reason the concurrency cap counts both. */
  it("counts a container, not a project", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, PROJECT]);
    await sampleCompute(later(60_000));

    expect(amount()).toBe(120);
  });

  /** A published service is always-on by definition, so it is the expensive
   *  case — and a meter that counted only sandboxes would be quietest about
   *  exactly what §8.8 is asking about. */
  it("counts a published service too", async () => {
    runningProjectContainers.mockResolvedValue([]);
    runningServices.mockResolvedValue(new Set(["quiet-fern-84f1"]));
    deploymentFindMany.mockResolvedValue([{ projectId: SECOND }]);
    projectFindMany.mockResolvedValue([{ id: SECOND, ownerId: OWNER }]);

    await sampleCompute(later(60_000));

    expect(amount()).toBe(60);
  });

  it("bills each owner for their own", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, SECOND]);
    projectFindMany.mockResolvedValue([
      { id: PROJECT, ownerId: OWNER },
      { id: SECOND, ownerId: OTHER },
    ]);

    await sampleCompute(later(60_000));

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(amount(0)).toBe(60);
    expect(amount(1)).toBe(60);
  });

  it("does nothing at all when the machine is idle", async () => {
    runningProjectContainers.mockResolvedValue([]);
    await sampleCompute(later(60_000));

    expect(upsert).not.toHaveBeenCalled();
  });

  /** One account whose row will not write must not cost every other account
   *  its measurement for the minute. */
  it("carries on past an account it cannot record", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, SECOND]);
    projectFindMany.mockResolvedValue([
      { id: PROJECT, ownerId: OWNER },
      { id: SECOND, ownerId: OTHER },
    ]);
    upsert.mockRejectedValueOnce(new Error("deadlock"));

    expect(await sampleCompute(later(60_000))).toBe(60);
  });

  /** Trashing stops a project's containers, so this is belt and braces — but
   *  a container Docker has not finished reporting would otherwise be metered
   *  against an account that has already deleted the project. */
  it("ignores a project in the trash", async () => {
    await sampleCompute(later(60_000));

    expect(projectFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { deletedAt: null },
    });
  });
});

describe("reading it back", () => {
  it("sums the days since the month began", async () => {
    usageFindMany.mockResolvedValue([{ seconds: 100 }, { seconds: 250 }]);

    expect(await computeSecondsSince(OWNER, startOfMonth(T0))).toBe(350);
    expect(usageFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: OWNER },
    });
  });

  it("starts a month at its first day, in UTC", () => {
    expect(startOfMonth(T0).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
