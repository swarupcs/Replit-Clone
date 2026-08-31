import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  plan: { findMany: vi.fn() },
}));

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

import {
  assertFeature,
  freePlanFallback,
  listPlans,
  ownerOf,
  parseOverride,
  resolveEntitlements,
  resolveProjectEntitlements,
  resetEntitlementCaches,
} from "./entitlementService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** A plan row as the database holds one. */
function plan(over: Record<string, unknown> = {}) {
  return {
    id: "pro",
    label: "Pro",
    priceCents: 1200,
    currency: "usd",
    rank: 1,
    maxProjects: 100,
    userDiskQuotaMb: 20480,
    projectDiskQuotaMb: 2048,
    aiRequestsPerHour: 500,
    maxContainersPerUser: 3,
    managedDatabases: true,
    customDomains: true,
    scheduledJobs: true,
    archivedAt: null,
    ...over,
  };
}

function account(over: Record<string, unknown> = {}) {
  return {
    entitlementOverride: null,
    overrideUntil: null,
    plan: plan(),
    ...over,
  };
}

beforeEach(() => {
  resetEntitlementCaches();
  prismaMock.user.findUnique.mockReset().mockResolvedValue(account());
  prismaMock.project.findUnique
    .mockReset()
    .mockResolvedValue({ ownerId: USER });
  prismaMock.plan.findMany.mockReset().mockResolvedValue([]);
});

describe("an account's plan", () => {
  it("is where its limits come from", async () => {
    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.planId).toBe("pro");
    expect(entitlements.maxProjects).toBe(100);
    expect(entitlements.aiRequestsPerHour).toBe(500);
    expect(entitlements.overridden).toBe(false);
  });

  /** These are read on the write path — every debounced save asks. */
  it("is read once and then remembered", async () => {
    await resolveEntitlements(USER);
    await resolveEntitlements(USER);

    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

/** The half of this that decides what a comped account gets. */
describe("an override", () => {
  it("replaces the numbers it names and leaves the rest", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({ entitlementOverride: { maxProjects: 5 } }),
    );

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.maxProjects).toBe(5);
    expect(entitlements.userDiskQuotaMb).toBe(20480);
    expect(entitlements.overridden).toBe(true);
  });

  /** The plan of record is what is paid for, not what has been granted on top
   *  of it. Conflating the two is how a billing system starts lying about
   *  revenue — and about who is on which tier. */
  it("does not change which plan the account is on", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({ entitlementOverride: { maxProjects: 5000 } }),
    );

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.planId).toBe("pro");
    expect(entitlements.planLabel).toBe("Pro");
  });

  it("stops applying once it has lapsed", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({
        entitlementOverride: { maxProjects: 5000 },
        overrideUntil: new Date(Date.now() - 60_000),
      }),
    );

    const entitlements = await resolveEntitlements(USER);

    // Back to the plan, not to nothing.
    expect(entitlements.maxProjects).toBe(100);
    expect(entitlements.overridden).toBe(false);
  });

  it("still applies before it lapses", async () => {
    const until = new Date(Date.now() + 86_400_000);
    prismaMock.user.findUnique.mockResolvedValue(
      account({
        entitlementOverride: { maxProjects: 5000 },
        overrideUntil: until,
      }),
    );

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.maxProjects).toBe(5000);
    expect(entitlements.overrideUntil).toBe(until.toISOString());
  });
});

/** A `Json` column is whatever was last written to it. */
describe("an override that is not one", () => {
  it("is ignored rather than trusted", () => {
    expect(parseOverride({ maxProjects: -4 })).toBeUndefined();
    expect(parseOverride({ maxProjects: "lots" })).toBeUndefined();
    expect(parseOverride("free for life")).toBeUndefined();
    expect(parseOverride(null)).toBeUndefined();
    expect(parseOverride({})).toBeUndefined();
  });

  /** A key that is not a limit is far likelier to be a typo for one that is
   *  than a deliberate extension, and applying the plan's number while an
   *  operator believes they changed it is the worse of the two failures. */
  it("is ignored when it carries a key that is not a limit", () => {
    expect(parseOverride({ maxProjects: 5, maxProject: 9 })).toBeUndefined();
  });

  /** Falls back to the PLAN, never to something larger. Garbage in this column
   *  must not be a way to buy a bigger quota. */
  it("leaves the account on its plan's limits", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({ entitlementOverride: { maxProjects: -1 } }),
    );

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.maxProjects).toBe(100);
    expect(entitlements.overridden).toBe(false);
  });
});

/** A quota lookup must never be the reason somebody's save fails. */
describe("a database that cannot be reached", () => {
  it("falls back to the free plan rather than refusing", async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error("down"));

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements).toEqual(freePlanFallback());
  });

  /** Open to the FREE plan, not open to no limit at all: an unreachable
   *  database must not be a way to buy an unbounded quota. */
  it("does not fall back to something unlimited", async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error("down"));

    const entitlements = await resolveEntitlements(USER);

    expect(entitlements.maxProjects).toBeGreaterThan(0);
    expect(Number.isFinite(entitlements.maxProjects)).toBe(true);
    expect(Number.isFinite(entitlements.userDiskQuotaMb)).toBe(true);
  });

  it("does the same for an account that no longer exists", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    expect(await resolveEntitlements(USER)).toEqual(freePlanFallback());
  });
});

/** Work done IN a project spends its owner's allowance, not the allowance of
 *  whoever happens to be typing. */
describe("a project's entitlements", () => {
  it("are its owner's", async () => {
    await resolveProjectEntitlements(PROJECT);

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER } }),
    );
  });

  it("remember the owner rather than asking twice", async () => {
    await ownerOf(PROJECT);
    await ownerOf(PROJECT);

    expect(prismaMock.project.findUnique).toHaveBeenCalledTimes(1);
  });

  it("fall back to the free plan for a project that is gone", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);

    expect(await resolveProjectEntitlements(PROJECT)).toEqual(
      freePlanFallback(),
    );
  });
});

describe("a feature the plan does not include", () => {
  it("is refused, and the refusal names the plan", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({ plan: plan({ scheduledJobs: false, label: "Starter" }) }),
    );

    await expect(assertFeature(PROJECT, "scheduledJobs")).rejects.toMatchObject(
      { statusCode: 403, code: "PLAN_FEATURE" },
    );
    await expect(assertFeature(PROJECT, "scheduledJobs")).rejects.toThrow(
      /Starter/,
    );
  });

  it("is allowed when the plan does include it", async () => {
    await expect(
      assertFeature(PROJECT, "scheduledJobs"),
    ).resolves.toBeUndefined();
  });

  /** An override is how a feature gets turned on for one account without
   *  inventing a plan row for one person. */
  it("can be granted to one account by an override", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      account({
        plan: plan({ customDomains: false }),
        entitlementOverride: { customDomains: true },
      }),
    );

    await expect(
      assertFeature(PROJECT, "customDomains"),
    ).resolves.toBeUndefined();
  });
});

describe("the catalogue", () => {
  /** Archiving a plan stops it being offered. It does not touch anybody
   *  already on it, which is why this is a filter and not a delete. */
  it("leaves out plans that are no longer offered", async () => {
    await listPlans();

    expect(prismaMock.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { archivedAt: null } }),
    );
  });
});
