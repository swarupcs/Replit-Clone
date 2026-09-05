import { beforeEach, describe, expect, it, vi } from "vitest";

/** How big one workspace is, and whether the host can afford it.
 *
 *  plan.md §12.1. The interesting part is not the column — it is the
 *  arithmetic, and the fact that this arithmetic is the only thing standing
 *  between "you may have 8 GB" and an OOM kill in somebody else's terminal.
 *
 *  §6 decision 15 is what shapes every test below. That decision forbids a
 *  plan PROMISING more than the host has; it does not forbid one workspace
 *  differing from another. So a size here is an allocation measured against
 *  what is running right now, and the tests are about the measuring.
 */

const projectFindUnique = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const projectUpdate = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: projectFindUnique,
      findMany: projectFindMany,
      update: projectUpdate,
    },
  },
}));

const info = vi.hoisted(() => vi.fn());
vi.mock("dockerode", () => ({
  default: class {
    info = info;
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const settings = vi.hoisted(
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  () => ({}) as Record<string, unknown>,
);
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/env.js")>();
  Object.assign(settings, actual.env, {
    CONTAINER_MEMORY_MB: 512,
    CONTAINER_CPUS: 0.5,
    HOST_MEMORY_RESERVE_MB: 1024,
    MAX_CONCURRENT_CONTAINERS: 3,
  });
  return { ...actual, env: settings };
});

import {
  assertFits,
  budgetMb,
  committedMb,
  forgetHostMemory,
  MIN_MEMORY_MB,
  resolveSize,
  setWorkspaceSize,
} from "./workspaceSizeService.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  forgetHostMemory();
  settings["HOST_MEMORY_MB"] = undefined;
  settings["CONTAINER_MEMORY_MB"] = 512;
  settings["CONTAINER_CPUS"] = 0.5;
  settings["HOST_MEMORY_RESERVE_MB"] = 1024;
  // A 16 GB host.
  info.mockResolvedValue({ MemTotal: 16384 * MB });
  projectFindUnique.mockResolvedValue({ memoryMb: null, cpus: null });
  projectFindMany.mockResolvedValue([]);
  projectUpdate.mockImplementation((args: { data: unknown }) =>
    Promise.resolve(args.data),
  );
});

describe("the size a container starts at", () => {
  it("is the deployment's default until somebody chooses one", async () => {
    const size = await resolveSize(PROJECT);

    expect(size).toEqual({ memoryMb: 512, cpus: 0.5, custom: false });
  });

  it("is this project's once they have", async () => {
    projectFindUnique.mockResolvedValue({ memoryMb: 8192, cpus: 4 });

    expect(await resolveSize(PROJECT)).toEqual({
      memoryMb: 8192,
      cpus: 4,
      custom: true,
    });
  });

  /** Half a size is a real state: somebody who wants more memory has no
   *  opinion about CPUs, and the other number must not become zero. */
  it("takes the default for whichever half was not chosen", async () => {
    projectFindUnique.mockResolvedValue({ memoryMb: 8192, cpus: null });

    expect(await resolveSize(PROJECT)).toEqual({
      memoryMb: 8192,
      cpus: 0.5,
      custom: true,
    });
  });

  /** A container start that raced a delete must not throw here. The caller's
   *  own guards are what should refuse it, and a crash in the sizing lookup
   *  would turn a clean refusal into a 500. */
  it("does not throw for a project that is no longer there", async () => {
    projectFindUnique.mockResolvedValue(null);

    expect(await resolveSize(PROJECT)).toEqual({
      memoryMb: 512,
      cpus: 0.5,
      custom: false,
    });
  });
});

describe("what the host can give away", () => {
  it("is what Docker says it has, less the reserve", async () => {
    expect(await budgetMb()).toBe(16384 - 1024);
  });

  /** Asked once. A `docker info` per resize is a round trip for a number that
   *  changes when a VM is resized and not otherwise. */
  it("is not asked of Docker on every call", async () => {
    await budgetMb();
    await budgetMb();

    expect(info).toHaveBeenCalledTimes(1);
  });

  it("is the operator's number when they set one", async () => {
    settings["HOST_MEMORY_MB"] = 4096;

    expect(await budgetMb()).toBe(4096 - 1024);
    // And Docker is not consulted at all, which is the point of an override
    // on a host whose daemon can see more than this server may have.
    expect(info).not.toHaveBeenCalled();
  });

  /** A daemon that will not say is not a reason to refuse every resize — but
   *  it is a reason not to invent a budget. The fallback is exactly what the
   *  machine was already assumed to hold. */
  it("falls back to the old assumption when Docker will not say", async () => {
    info.mockResolvedValue({});

    expect(await budgetMb()).toBe(512 * 3);
  });
});

describe("what is already committed", () => {
  /** Allocated, not used. A container sitting at 40 MB of its 2048 still has
   *  2048 reserved against the next OOM, and sizing the next workspace against
   *  current usage is how a host is oversubscribed by however idle it happens
   *  to be. */
  it("counts what each running workspace was promised", async () => {
    projectFindMany.mockResolvedValue([{ memoryMb: 8192 }, { memoryMb: null }]);

    expect(await committedMb([PROJECT, OTHER])).toBe(8192 + 512);
  });

  it("is nothing when nothing is running", async () => {
    expect(await committedMb([])).toBe(0);
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  /** A running container whose row has gone still holds its memory. Counting
   *  it at zero is how a deleted project's container becomes free capacity
   *  that does not exist. */
  it("counts a running container whose project row has gone", async () => {
    projectFindMany.mockResolvedValue([]);

    expect(await committedMb([PROJECT, OTHER])).toBe(512 * 2);
  });
});

describe("asking for a size", () => {
  it("is refused when it is larger than the host has", async () => {
    await expect(
      setWorkspaceSize(PROJECT, { memoryMb: 32768 }, []),
    ).rejects.toMatchObject({ statusCode: 400, code: "TOO_LARGE" });

    expect(projectUpdate).not.toHaveBeenCalled();
  });

  /** The message is the difference between somebody resizing their VM and
   *  somebody filing a bug, so it has to name both numbers. */
  it("says how much the host actually has when it refuses", async () => {
    await expect(
      setWorkspaceSize(PROJECT, { memoryMb: 32768 }, []),
    ).rejects.toThrow(/15360 MB/);
  });

  it("is refused when the room is there but is spoken for", async () => {
    projectFindMany.mockResolvedValue([{ memoryMb: 12288 }]);

    await expect(
      setWorkspaceSize(PROJECT, { memoryMb: 8192 }, [OTHER]),
    ).rejects.toMatchObject({ statusCode: 409, code: "NO_ROOM" });
  });

  /** Resizing a workspace that is already running REPLACES its allocation
   *  rather than adding to it. Counting it twice would refuse every increase
   *  on a busy host, which is the one moment somebody wants one. */
  it("does not count the project being resized against itself", async () => {
    projectFindMany.mockResolvedValue([]);

    await setWorkspaceSize(PROJECT, { memoryMb: 12288 }, [PROJECT]);

    expect(projectUpdate).toHaveBeenCalled();
    // The only id it asked about is the other one -- and there was not one.
    expect(projectFindMany).not.toHaveBeenCalled();
  });

  it("is refused below the floor a package manager needs", async () => {
    await expect(
      setWorkspaceSize(PROJECT, { memoryMb: MIN_MEMORY_MB - 1 }, []),
    ).rejects.toMatchObject({ statusCode: 400, code: "TOO_SMALL" });
  });

  it("is refused for a CPU count that is not a number of CPUs", async () => {
    for (const cpus of [0, -1, 1000]) {
      await expect(
        setWorkspaceSize(PROJECT, { cpus }, []),
      ).rejects.toMatchObject({ code: "BAD_CPUS" });
    }
  });

  it("is written when it fits", async () => {
    await setWorkspaceSize(PROJECT, { memoryMb: 8192, cpus: 4 }, []);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PROJECT },
        data: { memoryMb: 8192, cpus: 4 },
      }),
    );
  });

  /** The only way to undo a size without knowing what the default was. */
  it("goes back to the deployment default when asked for nothing", async () => {
    projectUpdate.mockResolvedValue({ memoryMb: null, cpus: null });

    const size = await setWorkspaceSize(PROJECT, { memoryMb: null, cpus: null }, []);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { memoryMb: null, cpus: null } }),
    );
    expect(size).toEqual({ memoryMb: 512, cpus: 0.5, custom: false });
  });

  /** Clearing a size must not be measured against the host: it can only ever
   *  free memory, and a full host would otherwise refuse the one request that
   *  would unfill it. */
  it("can be cleared even when the host is full", async () => {
    projectFindMany.mockResolvedValue([{ memoryMb: 15000 }]);
    projectUpdate.mockResolvedValue({ memoryMb: null, cpus: null });

    await expect(
      setWorkspaceSize(PROJECT, { memoryMb: null }, [OTHER]),
    ).resolves.toBeDefined();
  });
});

/** Found by the existing container tests rather than by anything written here,
 *  which is the §3.1 pattern exactly: every mock in this file sets the columns
 *  to an explicit null, so `undefined` — a caller that selected neither, or a
 *  row read before the migration ran — was a state the tests never produced.
 *  `undefined !== null` is true, so every such project read as custom and took
 *  a capacity check it was meant to be exempt from. */
describe("a row that does not carry the columns at all", () => {
  it("is not mistaken for a workspace somebody sized", async () => {
    projectFindUnique.mockResolvedValue({});

    expect(await resolveSize(PROJECT)).toEqual({
      memoryMb: 512,
      cpus: 0.5,
      custom: false,
    });
  });

  it("is counted at the default when it is running", async () => {
    projectFindMany.mockResolvedValue([{}, {}]);

    expect(await committedMb([PROJECT, OTHER])).toBe(512 * 2);
  });
});

/** The same arithmetic, asked at the moment a container starts.
 *
 *  §6 decision 13: the guarantee lives where it cannot be skipped. A size that
 *  fitted when it was set need not fit now — something else started in the
 *  meantime — and the start is the only place that cannot be gone around.
 */
describe("the check the container start makes", () => {
  it("passes when the host has room", async () => {
    await expect(assertFits(PROJECT, 8192, [PROJECT])).resolves.toBeUndefined();
  });

  it("refuses when something else took the room since", async () => {
    projectFindMany.mockResolvedValue([{ memoryMb: 12288 }]);

    await expect(assertFits(PROJECT, 8192, [PROJECT, OTHER])).rejects.toMatchObject({
      code: "NO_ROOM",
    });
  });

  /** The project being started is the one whose memory is about to be
   *  allocated, so counting its own row as already committed would refuse
   *  every restart of a large workspace. */
  it("does not count the starting project against itself", async () => {
    projectFindMany.mockResolvedValue([{ memoryMb: 12288 }]);

    // Same numbers as above, except that the 12288 belongs to THIS project.
    await expect(assertFits(OTHER, 2048, [PROJECT, OTHER])).resolves.toBeUndefined();
    expect(projectFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [PROJECT] } } }),
    );
  });
});
