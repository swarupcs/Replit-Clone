import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { projectRoot } from "../utils/projectPaths.js";
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

  it("does not follow a symlink out of the project", async () => {
    await seed({ "a.txt": 1024 });
    await fs.symlink("/usr", `${root}/escape`);
    forgetUsage(PROJECT);

    // /usr is far larger than any quota; counting it would blow this up.
    expect(await usedBytes(PROJECT)).toBeLessThan(1024 * 1024);
  });
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
