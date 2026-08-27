import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: { CHECKPOINTS_ENABLED: true } }));
vi.mock("../config/env.js", () => ({ env }));

// The logger reads its own fields off env, and this file's env double only
// carries the one field under test.
vi.mock("../lib/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { root } = vi.hoisted(() => ({ root: { dir: "" } }));
vi.mock("../utils/projectPaths.js", () => ({
  projectRoot: (projectId: string) => path.join(root.dir, projectId),
}));

const service = await import("./checkpointService.js");

describe("checkpoints", () => {
  beforeEach(async () => {
    env.CHECKPOINTS_ENABLED = true;
    root.dir = await fs.mkdtemp(path.join(os.tmpdir(), "rc-checkpoints-"));
    service.resetSnapshotClock();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Left on, a fake clock leaks into every test that runs after this file.
    vi.useRealTimers();
    await fs.rm(root.dir, { recursive: true, force: true });
  });

  it("records a version and reads it back", async () => {
    await service.snapshot("p1", "src/a.ts", "first");

    const [checkpoint] = await service.listCheckpoints("p1", "src/a.ts");
    expect(checkpoint).toBeDefined();
    expect(await service.readCheckpoint("p1", "src/a.ts", checkpoint!.at)).toBe("first");
  });

  /** Writes are debounced to about every keystroke pause. Snapshotting each
   *  one would keep twenty versions covering the last forty seconds —
   *  useless for noticing an hour later that something was deleted. */
  it("does not snapshot every save", async () => {
    await service.snapshot("p1", "a.ts", "one");
    await service.snapshot("p1", "a.ts", "two");
    await service.snapshot("p1", "a.ts", "three");

    expect(await service.listCheckpoints("p1", "a.ts")).toHaveLength(1);
  });

  it("snapshots again once the interval has passed", async () => {
    await service.snapshot("p1", "a.ts", "one");
    vi.advanceTimersByTime(61_000);
    await service.snapshot("p1", "a.ts", "two");

    expect(await service.listCheckpoints("p1", "a.ts")).toHaveLength(2);
  });

  it("keeps files apart", async () => {
    await service.snapshot("p1", "a.ts", "a");
    await service.snapshot("p1", "b.ts", "b");

    expect(await service.listCheckpoints("p1", "a.ts")).toHaveLength(1);
    expect(await service.listCheckpoints("p1", "b.ts")).toHaveLength(1);
  });

  it("keeps projects apart", async () => {
    await service.snapshot("p1", "a.ts", "one");
    await service.snapshot("p2", "a.ts", "two");

    const [first] = await service.listCheckpoints("p1", "a.ts");
    expect(await service.readCheckpoint("p1", "a.ts", first!.at)).toBe("one");
  });

  it("lists newest first", async () => {
    await service.snapshot("p1", "a.ts", "old");
    vi.advanceTimersByTime(61_000);
    await service.snapshot("p1", "a.ts", "new");

    const checkpoints = await service.listCheckpoints("p1", "a.ts");
    expect(checkpoints[0]!.at).toBeGreaterThan(checkpoints[1]!.at);
  });

  it("prunes past the retention window", async () => {
    for (let index = 0; index < 25; index += 1) {
      await service.snapshot("p1", "a.ts", `version ${String(index)}`);
      vi.advanceTimersByTime(61_000);
    }

    // A window, not a history: git is the thing that does the other job.
    expect((await service.listCheckpoints("p1", "a.ts")).length).toBeLessThanOrEqual(20);
  });

  it("says nothing about a file it has never seen", async () => {
    expect(await service.listCheckpoints("p1", "nope.ts")).toEqual([]);
    expect(await service.readCheckpoint("p1", "nope.ts", 123)).toBeNull();
  });

  /** `at` comes from the client. A path separator in it would escape the
   *  checkpoint directory, so it is validated as a number rather than
   *  interpolated on trust. */
  it("refuses a checkpoint id that is not a plain number", async () => {
    for (const bad of [Number.NaN, -1, 0, 1.5]) {
      expect(await service.readCheckpoint("p1", "a.ts", bad)).toBeNull();
    }
  });

  it("does nothing when checkpoints are switched off", async () => {
    env.CHECKPOINTS_ENABLED = false;
    await service.snapshot("p1", "a.ts", "one");
    expect(await service.listCheckpoints("p1", "a.ts")).toEqual([]);
  });

  /** A snapshot that cannot be written must never fail the save it was
   *  taken from: losing a snapshot is small, losing the write is the user's
   *  actual work. */
  it("never throws, whatever the disk says", async () => {
    // A regular file where a directory is expected: mkdir fails with ENOTDIR
    // immediately, which is the shape of a real disk problem without the
    // wait of an unreachable path.
    const blocker = path.join(root.dir, "blocker");
    await fs.writeFile(blocker, "not a directory");
    root.dir = blocker;

    await expect(service.snapshot("p1", "a.ts", "one")).resolves.toBeUndefined();
  });

  it("forgets a project entirely", async () => {
    await service.snapshot("p1", "a.ts", "one");
    await service.forgetProject("p1");
    expect(await service.listCheckpoints("p1", "a.ts")).toEqual([]);
  });
});
