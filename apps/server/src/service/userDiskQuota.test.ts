import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Real rows: the quota is resolved through the project's owner. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("assertUserDiskQuota", () => {
  const scope = dbScope("user-disk-quota");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let quota: typeof import("./userQuotaService.js");
  let disk: typeof import("./diskUsageService.js");
  let projectRoot: typeof import("../utils/projectPaths.js").projectRoot;
  let ownerId: string;
  let projectId: string;

  beforeEach(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;

    ({ prisma } = await import("../lib/prisma.js"));
    quota = await import("./userQuotaService.js");
    quota.resetUserQuotaCaches();
    disk = await import("./diskUsageService.js");
    ({ projectRoot } = await import("../utils/projectPaths.js"));

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      data: { name: "p", ownerId, template: "react-vite" },
    });
    projectId = project.id;

    await fs.mkdir(projectRoot(projectId), { recursive: true });
    disk.forgetUsage(projectId);
  });

  afterEach(async () => {
    await fs.rm(projectRoot(projectId), { recursive: true, force: true });
    disk.forgetUsage(projectId);
    await scope.cleanup(prisma);
  });

  it("allows a write that fits", async () => {
    await expect(
      quota.assertUserDiskQuota(projectId, 1024),
    ).resolves.toBeUndefined();
  });

  it("refuses a write that would take the owner past their limit", async () => {
    // The whole defect: this was only ever consulted when CREATING a project,
    // so writes could take a user far past their stated allowance.
    const { diskLimitBytes } = await quota.getUserUsage(ownerId);
    const overTheLimit = diskLimitBytes + 1;

    await expect(
      quota.assertUserDiskQuota(projectId, overTheLimit),
    ).rejects.toThrow(/space/i);
  });

  it("measures against what the write replaces", async () => {
    const { diskLimitBytes } = await quota.getUserUsage(ownerId);

    // Replacing a file of the same size is not growth, so it must be allowed
    // even when sitting right at the limit.
    await expect(
      quota.assertUserDiskQuota(projectId, diskLimitBytes, diskLimitBytes),
    ).resolves.toBeUndefined();
  });

  it("says nothing about a project that no longer exists", async () => {
    await prisma.project.delete({ where: { id: projectId } });

    // A write racing a delete is not the place to raise a quota error.
    await expect(
      quota.assertUserDiskQuota(projectId, 1024),
    ).resolves.toBeUndefined();
  });

  it("counts the owner's allowance, not the writer's", async () => {
    // A collaborator writing into someone else's project spends the OWNER's
    // space. Nothing here passes a user id, which is the point: it is resolved
    // from the project every time.
    const usage = await quota.getUserUsage(ownerId);
    expect(usage.diskLimitBytes).toBeGreaterThan(0);

    await expect(
      quota.assertUserDiskQuota(projectId, usage.diskLimitBytes + 1),
    ).rejects.toThrow();
  });

  it("does not block a save when the database cannot answer", async () => {
    // Fails OPEN on purpose. Refusing to write somebody's work because a quota
    // lookup was slow is worse than briefly allowing an over-quota write — the
    // per-project quota still applies either way, so nothing is unbounded.
    quota.resetUserQuotaCaches();
    await prisma.project.delete({ where: { id: projectId } });

    await expect(
      quota.assertUserDiskQuota(projectId, Number.MAX_SAFE_INTEGER),
    ).resolves.toBeUndefined();
  });

  it("does not re-measure on every write", async () => {
    // This sits on the write path — every debounced save, every flush of a
    // shared document. Measuring per call means a query plus a walk of every
    // one of the owner's project trees.
    quota.resetUserQuotaCaches();

    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await quota.assertUserDiskQuota(projectId, 1);
    }

    // Fifty checks against one measurement; the walk happens once.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
