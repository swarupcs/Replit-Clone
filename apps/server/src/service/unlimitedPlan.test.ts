import { beforeEach, describe, expect, it, vi } from "vitest";

/** A limit of zero is no limit, at all five places a limit is enforced.
 *
 *  The per-account numbers in this product ration a shared VM between tenants:
 *  how many projects, how much disk across them, how much per project, how many
 *  assistant requests an hour, how many containers at once. There is nobody to
 *  ration against at n=1, and a 512 MB project quota on somebody's own machine
 *  is an editor refusing to save into their own free space.
 *
 *  Every case here is written twice, because the dangerous failure is not
 *  "unlimited did not work". It is an exemption written slightly too wide,
 *  which would quietly remove the limits from every ordinary deployment and
 *  produce no failing test at all.
 *
 *  What is NOT here, deliberately: `CONTAINER_MEMORY_MB`,
 *  `MAX_CONCURRENT_CONTAINERS` and `DEPLOY_MEMORY_MB`. Those are the machine's
 *  and no plan touches them — §6 decision 15 — and that argument does not
 *  weaken at one user, because it is the same OOM kill in the same terminal.
 */

const projectFindMany = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findMany: projectFindMany },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

const resolveEntitlements = vi.hoisted(() => vi.fn());
const resolveProjectEntitlements = vi.hoisted(() => vi.fn());
const ownerOf = vi.hoisted(() => vi.fn());
vi.mock("./entitlementService.js", () => ({
  resolveEntitlements,
  resolveProjectEntitlements,
  ownerOf,
  forgetEntitlements: vi.fn(),
}));

const usedBytes = vi.hoisted(() => vi.fn());
vi.mock("./diskUsageService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diskUsageService.js")>()),
  usedBytes,
}));

vi.mock("./notificationService.js", () => ({ notify: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  assertCanCreateProject,
  assertUserDiskQuota,
  resetUserQuotaCaches,
} from "./userQuotaService.js";
import { assertWithinQuota } from "./diskUsageService.js";
import { assertWithinAiBudget, resetAiBudgets } from "./aiService.js";
import { isUnlimited, UNLIMITED } from "@replit-clone/shared";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const MB = 1024 * 1024;

/** A plan with every allocation unlimited, as `personal` is seeded. */
function personal() {
  return {
    planId: "personal",
    planLabel: "Personal",
    maxProjects: UNLIMITED,
    userDiskQuotaMb: UNLIMITED,
    projectDiskQuotaMb: UNLIMITED,
    aiRequestsPerHour: UNLIMITED,
    maxContainersPerUser: UNLIMITED,
    managedDatabases: true,
    customDomains: true,
    scheduledJobs: true,
    overridden: false,
    overrideUntil: null,
  };
}

/** The free plan's numbers, which are the `env` defaults. */
function free() {
  return {
    ...personal(),
    planId: "free",
    planLabel: "Free",
    maxProjects: 20,
    userDiskQuotaMb: 2048,
    projectDiskQuotaMb: 512,
    aiRequestsPerHour: 60,
    maxContainersPerUser: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUserQuotaCaches();
  resetAiBudgets();
  usedBytes.mockResolvedValue(0);
  ownerOf.mockResolvedValue(USER);
  projectFindMany.mockResolvedValue([]);
});

describe("the sentinel itself", () => {
  it("reads zero as no limit", () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(0)).toBe(true);
  });

  it("reads any real allowance as a limit", () => {
    expect(isUnlimited(1)).toBe(false);
    expect(isUnlimited(2048)).toBe(false);
  });

  it("reads a negative as no limit rather than as a very small one", () => {
    // Nothing should produce one. If a bad override or a hand-edited row does,
    // the safe reading is "no limit" and not "every save is refused" — the
    // second is an account that cannot be used, which is suspension, and §6
    // decision 18 puts that outside what this system does by accident.
    expect(isUnlimited(-1)).toBe(true);
  });
});

describe("how many projects", () => {
  it("is not capped on an unlimited plan", async () => {
    resolveEntitlements.mockResolvedValue(personal());
    projectFindMany.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => ({ id: `p${String(i)}` })),
    );

    await expect(assertCanCreateProject(USER)).resolves.toBeUndefined();
  });

  it("is still capped on an ordinary plan", async () => {
    resolveEntitlements.mockResolvedValue(free());
    projectFindMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ id: `p${String(i)}` })),
    );

    await expect(assertCanCreateProject(USER)).rejects.toMatchObject({
      code: "PROJECT_LIMIT",
    });
  });
});

describe("the account's disk", () => {
  it("is not capped on an unlimited plan", async () => {
    resolveEntitlements.mockResolvedValue(personal());
    usedBytes.mockResolvedValue(500 * 1024 * MB);

    await expect(
      assertUserDiskQuota(PROJECT, 10 * 1024 * MB),
    ).resolves.toBeUndefined();
  });

  it("is still capped on an ordinary plan", async () => {
    resolveEntitlements.mockResolvedValue(free());
    projectFindMany.mockResolvedValue([{ id: PROJECT }]);
    usedBytes.mockResolvedValue(2048 * MB);

    await expect(
      assertUserDiskQuota(PROJECT, 100 * MB),
    ).rejects.toMatchObject({ code: "USER_DISK_LIMIT" });
  });

  it("does not block creating a project on an unlimited plan either", async () => {
    resolveEntitlements.mockResolvedValue(personal());
    projectFindMany.mockResolvedValue([{ id: PROJECT }]);
    usedBytes.mockResolvedValue(900 * 1024 * MB);

    // Two comparisons in `assertCanCreateProject`, and both had to learn it:
    // the project count and the disk. Missing the second would refuse the
    // first project after the disk passed a limit that does not exist.
    await expect(assertCanCreateProject(USER)).resolves.toBeUndefined();
  });
});

describe("one project's disk", () => {
  // `usedBytes` is not mocked for these two: `assertWithinQuota` calls the
  // module-local binding rather than the export, so a mock of the export would
  // silently not apply and the test would be asserting against the real walk
  // of a directory that does not exist. It measures zero, so the INCOMING size
  // carries both cases -- which is the honest way to write them anyway.
  it("is not capped on an unlimited plan", async () => {
    resolveProjectEntitlements.mockResolvedValue(personal());

    await expect(
      assertWithinQuota(PROJECT, 10 * 1024 * MB),
    ).resolves.toBeUndefined();
  });

  it("is still capped on an ordinary plan", async () => {
    resolveProjectEntitlements.mockResolvedValue(free());

    // 600 MB into a 512 MB project quota.
    await expect(assertWithinQuota(PROJECT, 600 * MB)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
  });
});

describe("the assistant's hourly budget", () => {
  it("is not capped on an unlimited plan", () => {
    // The cap exists because ANTHROPIC_API_KEY bills one account for
    // everybody's use. When there is one person, the budget is theirs.
    for (let i = 0; i < 200; i += 1) {
      assertWithinAiBudget(USER, UNLIMITED);
    }

    expect(() => assertWithinAiBudget(USER, UNLIMITED)).not.toThrow();
  });

  it("is still capped on an ordinary plan", () => {
    for (let i = 0; i < 60; i += 1) assertWithinAiBudget(USER, 60);

    expect(() => assertWithinAiBudget(USER, 60)).toThrowError(
      /limit for the assistant/i,
    );
  });
});
