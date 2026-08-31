import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  user: { update: vi.fn() },
  accountAction: { create: vi.fn() },
}));

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  plan: { findUnique: vi.fn() },
  accountAction: { findMany: vi.fn() },
  scheduledRun: { count: vi.fn() },
  $transaction: vi.fn(),
}));

const notify = vi.hoisted(() => vi.fn());
const forgetEntitlements = vi.hoisted(() => vi.fn());
const runningContainerCount = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./notificationService.js", () => ({ notify }));
vi.mock("./userQuotaService.js", () => ({
  getUserUsage: vi.fn(() =>
    Promise.resolve({
      projects: 2,
      projectLimit: 20,
      diskBytes: 1024,
      diskLimitBytes: 2048,
    }),
  ),
}));
vi.mock("../containers/containerManager.js", () => ({ runningContainerCount }));

/** Partially: `parseOverride` is the real one, because the point of validating
 *  an override here is that it is checked by the same code that reads it back.
 *  Only the two functions with side effects are replaced. */
vi.mock("./entitlementService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./entitlementService.js")>()),
  forgetEntitlements,
  resolveEntitlements: vi.fn(() => Promise.resolve({ planId: "free" })),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));
vi.mock("../lib/metrics.js", () => ({
  increment: vi.fn(),
  snapshot: vi.fn(() => ({ jobs_started: 4 })),
}));

import {
  getMachineStatus,
  searchAccounts,
  setAccountOverride,
  setAccountPlan,
} from "./accountAdminService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "operator@example.com";

function action() {
  return {
    id: "a1",
    subjectUserId: USER,
    subjectEmail: "someone@example.com",
    action: "PLAN_CHANGED",
    actor: ACTOR,
    reason: "They asked.",
    detail: "Free to Pro",
    createdAt: new Date("2026-08-31T09:00:00.000Z"),
  };
}

beforeEach(() => {
  tx.user.update.mockReset().mockResolvedValue({});
  tx.accountAction.create.mockReset().mockResolvedValue(action());

  prismaMock.user.findUnique.mockReset().mockResolvedValue({
    email: "someone@example.com",
    entitlementOverride: null,
    plan: { id: "free", label: "Free" },
  });
  prismaMock.user.findMany.mockReset().mockResolvedValue([]);
  prismaMock.plan.findUnique.mockReset().mockResolvedValue({
    id: "pro",
    label: "Pro",
    archivedAt: null,
  });
  prismaMock.accountAction.findMany.mockReset().mockResolvedValue([]);
  prismaMock.scheduledRun.count.mockReset().mockResolvedValue(0);
  prismaMock.$transaction.mockReset().mockImplementation((run: (client: unknown) => unknown) =>
    Promise.resolve(run(tx)),
  );

  notify.mockReset().mockResolvedValue("n1");
  forgetEntitlements.mockReset();
  runningContainerCount.mockReset().mockResolvedValue(1);
});

/** §6 decision 11: the moderation authority is small *because* nothing
 *  reviews it. This is the first power in the product that acts on a person,
 *  so the record of it is not a follow-up commit. */
describe("changing an account's plan", () => {
  it("writes the change and the record in one transaction", async () => {
    await setAccountPlan({
      userId: USER,
      planId: "pro",
      actor: ACTOR,
      reason: "  They asked.  ",
    });

    // Both on the SAME client. A log that can be missing the entry for the
    // action it exists to describe is not a log.
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planId: "pro" } }),
    );
    expect(tx.accountAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PLAN_CHANGED",
          actor: ACTOR,
          reason: "They asked.",
          detail: "Free to Pro",
        }) as unknown,
      }),
    );
  });

  /** An operator who can silently change what somebody pays for is a worse
   *  position than this product was in before the console existed. */
  it("refuses without a reason, before anything is written", async () => {
    await expect(
      setAccountPlan({ userId: USER, planId: "pro", actor: ACTOR, reason: "   " }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  /** The same argument the takedown notification makes: a decision taken
   *  about somebody by somebody else is one they hear from us. */
  it("tells the account holder, and says who decided what and why", async () => {
    await setAccountPlan({
      userId: USER,
      planId: "pro",
      actor: ACTOR,
      reason: "Comped for the beta.",
    });

    const sent = notify.mock.calls[0]?.[0] as {
      userId: string;
      kind: string;
      body: string;
    };
    expect(sent.userId).toBe(USER);
    expect(sent.kind).toBe("PLAN_CHANGED");
    expect(sent.body).toMatch(/Free to Pro/);
    expect(sent.body).toMatch(/Comped for the beta\./);
  });

  /** The entitlement cache would otherwise serve the old plan for up to its
   *  TTL, which is how somebody is upgraded and refused anyway. */
  it("stops the old plan being served from cache", async () => {
    await setAccountPlan({
      userId: USER,
      planId: "pro",
      actor: ACTOR,
      reason: "ok",
    });

    expect(forgetEntitlements).toHaveBeenCalledWith(USER);
  });

  /** Archiving is what stops a withdrawn tier being handed to somebody new,
   *  and an operator doing it by hand is exactly the case it has to stop. */
  it("will not move anybody onto a plan that is no longer offered", async () => {
    prismaMock.plan.findUnique.mockResolvedValue({
      id: "legacy",
      label: "Legacy",
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      setAccountPlan({ userId: USER, planId: "legacy", actor: ACTOR, reason: "x" }),
    ).rejects.toMatchObject({ code: "PLAN_ARCHIVED" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a plan or an account that does not exist", async () => {
    prismaMock.plan.findUnique.mockResolvedValue(null);
    await expect(
      setAccountPlan({ userId: USER, planId: "nope", actor: ACTOR, reason: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(
      setAccountPlan({ userId: USER, planId: "pro", actor: ACTOR, reason: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  /** A no-op that writes an audit entry is an audit trail that fills with
   *  things that did not happen. */
  it("refuses a change to the plan the account is already on", async () => {
    prismaMock.plan.findUnique.mockResolvedValue({
      id: "free",
      label: "Free",
      archivedAt: null,
    });

    await expect(
      setAccountPlan({ userId: USER, planId: "free", actor: ACTOR, reason: "x" }),
    ).rejects.toMatchObject({ code: "PLAN_UNCHANGED" });
  });
});

describe("setting limits by hand", () => {
  it("stores the override and records what was granted", async () => {
    await setAccountOverride({
      userId: USER,
      override: { maxProjects: 50 },
      actor: ACTOR,
      reason: "Beta tester.",
    });

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entitlementOverride: { maxProjects: 50 },
        }) as unknown,
      }),
    );
    expect(tx.accountAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "OVERRIDE_SET",
          detail: "maxProjects 50",
        }) as unknown,
      }),
    );
  });

  /** Validated by the same schema that reads it back, so an override that
   *  could not be parsed can never be stored — otherwise it would be silently
   *  ignored later and the operator would believe it had applied. */
  it("refuses limits this product does not have", async () => {
    await expect(
      setAccountOverride({
        userId: USER,
        override: { maxProject: 50 } as unknown as Record<string, number>,
        actor: ACTOR,
        reason: "typo",
      }),
    ).rejects.toMatchObject({ code: "BAD_OVERRIDE" });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a negative limit for the same reason", async () => {
    await expect(
      setAccountOverride({
        userId: USER,
        override: { maxProjects: -1 },
        actor: ACTOR,
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_OVERRIDE" });
  });

  /** A trial that has to be remembered to be ended is a trial that never
   *  ends. */
  it("can be given an expiry", async () => {
    await setAccountOverride({
      userId: USER,
      override: { maxProjects: 50 },
      expiresInDays: 30,
      actor: ACTOR,
      reason: "Trial.",
    });

    const written = tx.user.update.mock.calls[0]?.[0] as {
      data: { overrideUntil: Date | null };
    };
    expect(written.data.overrideUntil).toBeInstanceOf(Date);
  });

  it("also drops the cached entitlements", async () => {
    await setAccountOverride({
      userId: USER,
      override: { maxProjects: 50 },
      actor: ACTOR,
      reason: "Beta tester.",
    });

    expect(forgetEntitlements).toHaveBeenCalledWith(USER);
  });

  it("clears back to the plan, and says so", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      email: "someone@example.com",
      entitlementOverride: { maxProjects: 50 },
      plan: { id: "free", label: "Free" },
    });

    await setAccountOverride({
      userId: USER,
      override: null,
      actor: ACTOR,
      reason: "Trial over.",
    });

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entitlementOverride: null,
          overrideUntil: null,
        }) as unknown,
      }),
    );
    expect(tx.accountAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "OVERRIDE_CLEARED" }) as unknown,
      }),
    );

    const sent = notify.mock.calls[0]?.[0] as { body: string };
    expect(sent.body).toMatch(/back to what its plan allows/i);
  });

  it("refuses to clear one that is not there", async () => {
    await expect(
      setAccountOverride({
        userId: USER,
        override: null,
        actor: ACTOR,
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "NO_OVERRIDE" });
  });

  it("refuses without a reason, like every other write here", async () => {
    await expect(
      setAccountOverride({
        userId: USER,
        override: { maxProjects: 50 },
        actor: ACTOR,
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });
});

describe("finding an account", () => {
  /** What an operator has when somebody writes in is part of an address. */
  it("matches part of an address, whatever the case", async () => {
    await searchAccounts("  SOME  ");

    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { contains: "SOME", mode: "insensitive" } },
      }),
    );
  });

  /** Disk costs a walk of every tree an account owns; twenty-five of those
   *  would make search the most expensive request in the product. */
  it("does not measure disk for a page of results", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: USER,
        email: "someone@example.com",
        createdAt: new Date(),
        entitlementOverride: null,
        overrideUntil: null,
        plan: { id: "free", label: "Free" },
        _count: { projects: 3 },
      },
    ]);

    const rows = await searchAccounts("some");

    expect(rows[0]).toMatchObject({ projects: 3, planLabel: "Free" });
    expect(rows[0]).not.toHaveProperty("diskBytes");
  });

  /** A lapsed override is not one, and a list that said otherwise would have
   *  an operator hunting for limits that are no longer applied. */
  it("does not call a lapsed override an override", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: USER,
        email: "someone@example.com",
        createdAt: new Date(),
        entitlementOverride: { maxProjects: 50 },
        overrideUntil: new Date(Date.now() - 60_000),
        plan: { id: "free", label: "Free" },
        _count: { projects: 0 },
      },
    ]);

    expect((await searchAccounts("some"))[0]?.overridden).toBe(false);
  });
});

describe("is this machine full", () => {
  it("answers with what is running against what is allowed", async () => {
    runningContainerCount.mockResolvedValue(2);
    prismaMock.scheduledRun.count.mockResolvedValue(1);

    const status = await getMachineStatus();

    expect(status.containersRunning).toBe(2);
    expect(status.containerLimit).toBeGreaterThan(0);
    expect(status.runningJobRuns).toBe(1);
    expect(status.counters).toMatchObject({ jobs_started: 4 });
  });

  /** An operator opening this screen because something is wrong must not be
   *  met with an error page because the thing that is wrong is Docker. */
  it("still answers when Docker does not", async () => {
    runningContainerCount.mockRejectedValue(new Error("no daemon"));

    await expect(getMachineStatus()).resolves.toMatchObject({
      containersRunning: 0,
    });
  });
});
