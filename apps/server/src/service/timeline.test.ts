import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const roots = vi.hoisted(() => ({ current: "" }));
vi.mock("../config/env.js", () => ({
  env: { CHECKPOINTS_ENABLED: true },
}));
// Only `projectRoot` is used, and only to build a sibling directory. Mocked to
// a temp path so these run without a projects tree.
vi.mock("../utils/projectPaths.js", () => ({
  projectRoot: (id: string) => path.join(roots.current, id),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { listCheckpoints, readCheckpoint } from "./checkpointService.js";

/** §10.12's premise was that checkpoints are "whole-project, explicit". They
 *  are neither — `snapshot()` runs per file on every save — and what was
 *  missing was that nothing could READ them. These cover the reading half's
 *  two failure modes, which are the ones a client can provoke. */

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const made: string[] = [];

beforeEach(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-timeline-"));
  made.push(root);
  roots.current = root;
});

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("reading a file's earlier versions", () => {
  it("is empty for a file that has never been saved", async () => {
    await expect(listCheckpoints(PROJECT, "never-written.ts")).resolves.toEqual([]);
  });

  it("answers null for a timestamp that is not one", async () => {
    // Two things stop a client's `at` from becoming a path: the explicit
    // `Number.isSafeInteger` check, and the fact that a bad value names a file
    // that does not exist. Only the OUTCOME is observable here, and it is the
    // outcome that matters — mutating the check away leaves this green, which
    // is worth knowing rather than worth pretending otherwise.
    for (const bad of [Number.NaN, -1, 0, 1.5]) {
      await expect(readCheckpoint(PROJECT, "a.ts", bad)).resolves.toBeNull();
    }
  });

  it("is null for a version that has been pruned away", async () => {
    // The service keeps a bounded number, so this is ordinary rather than
    // exceptional -- and the panel says "no longer kept" instead of "error".
    await expect(readCheckpoint(PROJECT, "a.ts", 1_757_462_400_000)).resolves.toBeNull();
  });
});
