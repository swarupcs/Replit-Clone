import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  project: { findMany: vi.fn() },
}));

const notify = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./notificationService.js", () => ({ notify }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import {
  isNearQuota,
  reviewQuotaWarning,
  type UserUsage,
} from "./userQuotaService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const MB = 1024 * 1024;

function usage(over: Partial<UserUsage> = {}): UserUsage {
  return {
    projects: 1,
    projectLimit: 20,
    diskBytes: 10 * MB,
    diskLimitBytes: 2048 * MB,
    ...over,
  };
}

/** Never warned before. */
function fresh() {
  prismaMock.user.findUnique.mockResolvedValue({ quotaWarnedAt: null });
}

/** Already told, and not yet back under the line. */
function alreadyWarned() {
  prismaMock.user.findUnique.mockResolvedValue({
    quotaWarnedAt: new Date("2026-08-30T09:00:00.000Z"),
  });
}

beforeEach(() => {
  prismaMock.user.findUnique.mockReset();
  prismaMock.user.update.mockReset().mockResolvedValue({});
  notify.mockReset().mockResolvedValue("notification-1");
  fresh();
});

describe("what counts as nearly out of room", () => {
  it("is either quota, not both", () => {
    expect(isNearQuota(usage({ diskBytes: 1700 * MB }))).toBe(true);
    expect(isNearQuota(usage({ projects: 16 }))).toBe(true);
    expect(isNearQuota(usage())).toBe(false);
  });

  /** The threshold is the constant the account screen paints amber at, so the
   *  bar and the message cannot disagree about what "nearly full" means. */
  it("is the last fifth exactly", () => {
    expect(isNearQuota(usage({ projects: 15 }))).toBe(false);
    expect(isNearQuota(usage({ projects: 16 }))).toBe(true);
  });

  /** A plan with a zero limit is a plan that refuses everything, and dividing
   *  by it is how a warning becomes a crash on the write path. */
  it("is not confused by a limit of zero", () => {
    expect(() =>
      isNearQuota(usage({ projectLimit: 0, diskLimitBytes: 0 })),
    ).not.toThrow();
    expect(isNearQuota(usage({ projectLimit: 0, diskLimitBytes: 0 }))).toBe(
      false,
    );
  });
});

describe("crossing into the last fifth", () => {
  it("is told once, and the bit is set", async () => {
    await reviewQuotaWarning(USER, usage({ diskBytes: 1700 * MB }));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, kind: "QUOTA_WARNING" }),
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { quotaWarnedAt: expect.any(Date) as Date },
      }),
    );
  });

  /** §6 decision 14, and the whole design. An account that sits at 90% for a
   *  month is one piece of news: a message a week about a number that has not
   *  changed is how a warning people needed earns itself a filter rule. */
  it("says nothing the second time, or the thirtieth", async () => {
    alreadyWarned();

    await reviewQuotaWarning(USER, usage({ diskBytes: 1700 * MB }));
    await reviewQuotaWarning(USER, usage({ diskBytes: 1900 * MB }));

    expect(notify).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  /** The message has to be worth reading on its own — it is mailed, where
   *  there is no meter beside it. */
  it("says roughly how full, and that nothing has been refused", async () => {
    await reviewQuotaWarning(USER, usage({ diskBytes: 1740 * MB }));

    const sent = notify.mock.calls[0]?.[0] as { body: string; link?: string };
    expect(sent.body).toMatch(/8[0-9]%/);
    expect(sent.body).toMatch(/nothing has been refused/i);
    // Points at the screen that shows both meters rather than at the
    // dashboard, which would be telling somebody where to look.
    expect(sent.link).toBe("/?view=account");
  });
});

describe("dropping back under the line", () => {
  /** Silent, which is where this differs from a job recovering. Nobody was
   *  harmed by a wall they did not hit, and somebody who has just deleted a
   *  project to make room does not need to be told that it worked. */
  it("clears the bit and says nothing", async () => {
    alreadyWarned();

    await reviewQuotaWarning(USER, usage());

    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quotaWarnedAt: null } }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  /** ...and the point of clearing it: the next crossing is news again. */
  it("lets the next crossing speak", async () => {
    alreadyWarned();
    await reviewQuotaWarning(USER, usage());

    fresh();
    await reviewQuotaWarning(USER, usage({ projects: 18 }));

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all for an account that was never near", async () => {
    await reviewQuotaWarning(USER, usage());

    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

/** This runs off the write path. A warning that could not be sent must not
 *  become a save that failed. */
describe("when the announcement itself fails", () => {
  it("does not throw at the caller", async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error("down"));

    await expect(
      reviewQuotaWarning(USER, usage({ projects: 19 })),
    ).resolves.toBeUndefined();
  });

  it("does the same when the account has gone", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await reviewQuotaWarning(USER, usage({ projects: 19 }));

    expect(notify).not.toHaveBeenCalled();
  });
});
