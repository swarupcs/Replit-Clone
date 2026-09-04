import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canSymlink } from "../test/capabilities.js";
import { env } from "../config/env.js";
import {
  projectRoot,
  registerLocalRoot,
  resetLocalRoots,
} from "../utils/projectPaths.js";
import {
  assertWithinQuota,
  forgetUsage,
  recordWrite,
  usedBytes,
} from "./diskUsageService.js";

const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const root = projectRoot(PROJECT);
const QUOTA_BYTES = env.PROJECT_DISK_QUOTA_MB * 1024 * 1024;

async function seed(sizes: Record<string, number>): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  forgetUsage(PROJECT);
  await fs.mkdir(`${root}/nested`, { recursive: true });

  for (const [name, size] of Object.entries(sizes)) {
    await fs.writeFile(`${root}/${name}`, "x".repeat(size));
  }
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  forgetUsage(PROJECT);
});

describe("usedBytes", () => {
  it("counts nested files, not just the top level", async () => {
    await seed({ "a.txt": 4096, "nested/b.txt": 4096 });

    // Block-granular, so assert on the order of magnitude rather than exactly.
    expect(await usedBytes(PROJECT)).toBeGreaterThanOrEqual(8192);
  });

  it("reports an empty project as nearly nothing", async () => {
    await seed({});
    expect(await usedBytes(PROJECT)).toBeLessThan(4096);
  });

  it.skipIf(!canSymlink)(
    "does not follow a symlink out of the project",
    async () => {
      await seed({ "a.txt": 1024 });
      await fs.symlink("/usr", `${root}/escape`);
      forgetUsage(PROJECT);

      // /usr is far larger than any quota; counting it would blow this up.
      expect(await usedBytes(PROJECT)).toBeLessThan(1024 * 1024);
    },
  );
});

describe("assertWithinQuota", () => {
  it("allows a write that fits", async () => {
    await seed({ "a.txt": 1024 });
    await expect(assertWithinQuota(PROJECT, 1024)).resolves.toBeUndefined();
  });

  it("refuses a write that would exceed the quota", async () => {
    await seed({ "a.txt": 1024 });

    await expect(assertWithinQuota(PROJECT, QUOTA_BYTES + 1)).rejects.toThrow(
      /reached its .* limit/,
    );
  });

  it("reports the failure as 507 with a code the client can branch on", async () => {
    await seed({});

    await assertWithinQuota(PROJECT, QUOTA_BYTES * 2).then(
      () => expect.unreachable("should have thrown"),
      (error: { statusCode: number; code: string }) => {
        expect(error.statusCode).toBe(507);
        expect(error.code).toBe("QUOTA_EXCEEDED");
      },
    );
  });

  it("allows overwriting a large file with a smaller one when already full", async () => {
    await seed({});
    // Pretend the project is at its limit, then replace all of it with less.
    recordWrite(PROJECT, QUOTA_BYTES, 0);

    await expect(
      assertWithinQuota(PROJECT, 1024, QUOTA_BYTES),
    ).resolves.toBeUndefined();
  });

  it("counts writes recorded since the last measurement", async () => {
    await seed({});
    await usedBytes(PROJECT);

    recordWrite(PROJECT, QUOTA_BYTES, 0);

    await expect(assertWithinQuota(PROJECT, 4096)).rejects.toThrow(
      /QUOTA|limit/i,
    );
  });
});

describe("a folder somebody opened", () => {
  // Registered AFTER `root` was computed above, so the two ids are distinct
  // and the ordinary cases in this file are unaffected.
  const LOCAL = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  afterEach(() => {
    resetLocalRoots();
  });

  it("uses no quota, because the disk is not this platform's", async () => {
    registerLocalRoot(LOCAL, root);

    // `root` genuinely has bytes in it in the cases above; what is asserted is
    // that they stop being counted, not that the directory is empty.
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(`${root}/big.txt`, "x".repeat(65536));

    expect(await usedBytes(LOCAL)).toBe(0);
  });

  it("is never refused a write for being over it", async () => {
    registerLocalRoot(LOCAL, root);

    // A quota is a promise about space this platform allocates. Somebody
    // saving a file into their own directory is not spending it, and an
    // editor that refuses is the failure mode this guard exists to prevent.
    await expect(
      assertWithinQuota(LOCAL, QUOTA_BYTES * 10),
    ).resolves.toBeUndefined();
  });

  it("does not change the answer for an ordinary project", async () => {
    registerLocalRoot(LOCAL, root);
    await seed({ "a.txt": 4096 });

    // The guard keys on the project, not on the path, so a server-owned
    // project sharing this test's directory is still measured and still
    // refused past the limit.
    expect(await usedBytes(PROJECT)).toBeGreaterThan(0);
    await expect(assertWithinQuota(PROJECT, QUOTA_BYTES * 10)).rejects.toThrow();
  });
});
