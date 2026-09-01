import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  project: { findMany: vi.fn() },
}));

const usedBytes = vi.hoisted(() => vi.fn());
const resolveEntitlements = vi.hoisted(() => vi.fn());
const listPlans = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./diskUsageService.js", () => ({ usedBytes }));
vi.mock("./entitlementService.js", () => ({ resolveEntitlements, listPlans }));

import { getAccountSummary } from "./accountService.js";

const USER = "11111111-1111-4111-8111-111111111111";

const ENTITLEMENTS = {
  planId: "free",
  planLabel: "Free",
  maxProjects: 20,
  userDiskQuotaMb: 2048,
  projectDiskQuotaMb: 512,
  aiRequestsPerHour: 60,
  maxContainersPerUser: 2,
  managedDatabases: true,
  customDomains: true,
  scheduledJobs: true,
  overridden: false,
  overrideUntil: null,
};

beforeEach(() => {
  prismaMock.user.findUnique
    .mockReset()
    .mockResolvedValue({ email: "someone@example.com" });
  prismaMock.project.findMany.mockReset().mockResolvedValue([]);
  usedBytes.mockReset().mockResolvedValue(0);
  resolveEntitlements.mockReset().mockResolvedValue(ENTITLEMENTS);
  listPlans.mockReset().mockResolvedValue([]);
});

describe("the account summary", () => {
  it("reports usage against this account's limits, not the deployment's", async () => {
    resolveEntitlements.mockResolvedValue({
      ...ENTITLEMENTS,
      planLabel: "Pro",
      maxProjects: 100,
    });
    prismaMock.project.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
    ]);

    const summary = await getAccountSummary(USER);

    expect(summary.projects).toBe(1);
    expect(summary.entitlements.maxProjects).toBe(100);
    expect(summary.entitlements.planLabel).toBe("Pro");
  });

  /** The half that makes a quota actionable: "you are out of space" is not
   *  something anybody can act on, and "this project is most of it" is. */
  it("names the projects, largest first", async () => {
    prismaMock.project.findMany.mockResolvedValue([
      { id: "small", name: "Small" },
      { id: "big", name: "Big" },
    ]);
    usedBytes.mockImplementation((id: string) =>
      Promise.resolve(id === "big" ? 900 : 100),
    );

    const summary = await getAccountSummary(USER);

    expect(summary.breakdown.map((entry) => entry.name)).toEqual([
      "Big",
      "Small",
    ]);
    expect(summary.diskBytes).toBe(1000);
  });

  /** Owned only. A project shared with somebody costs its owner, not everybody
   *  who can open it — the same rule the quota itself applies. */
  it("counts only the projects this account owns", async () => {
    await getAccountSummary(USER);

    expect(prismaMock.project.findMany).toHaveBeenCalledWith(
      // ...and not the ones in the trash, which stop counting the moment
      // they are trashed. This screen explains the number the quota enforces,
      // and a breakdown that does not add up to it is worse than none.
      expect.objectContaining({ where: { ownerId: USER, deletedAt: null } }),
    );
  });

  it("says so for an account with nothing in it", async () => {
    const summary = await getAccountSummary(USER);

    expect(summary.projects).toBe(0);
    expect(summary.diskBytes).toBe(0);
    expect(summary.breakdown).toEqual([]);
  });

  it("refuses for an account that does not exist", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(getAccountSummary(USER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
