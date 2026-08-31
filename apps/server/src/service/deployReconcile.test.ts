import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the panel says about a build the server did not live to finish.
 *
 *  `BUILDING` is written before the build starts and overwritten when it ends,
 *  so a restart in between leaves a row claiming progress that no process is
 *  making. The same root cause as the scheduled-job wedge and a much softer
 *  landing — `reserve()` overwrites the status on the next publish, so nothing
 *  is stuck — but until somebody deploys again the panel is wrong about the
 *  only thing it exists to say.
 */

const updateMany = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    deployment: {
      findMany: () => Promise.resolve([]),
      updateMany: (args: unknown): unknown => updateMany(args),
    },
  },
}));

vi.mock("../containers/deployContainer.js", () => ({
  serviceTarget: vi.fn(),
  serviceLogs: vi.fn(),
  startService: vi.fn(),
  removeService: vi.fn(),
  waitForService: vi.fn(),
  runningServices: vi.fn(),
}));

let service: typeof import("./deployService.js");

beforeEach(async () => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 0 });
  service = await import("./deployService.js");
});

describe("at boot", () => {
  it("settles rows that claim a build nobody is running", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await service.reconcileDeployments()).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: "BUILDING" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  /** FAILED and not deleted: the row carries the subdomain, and a deployment
   *  that has been published before must keep its address. The error text is
   *  what makes it actionable — an interrupted build did nothing wrong and
   *  only needs asking again. */
  it("says the build was interrupted rather than broken", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await service.reconcileDeployments();

    const data = (updateMany.mock.calls[0]?.[0] as { data: { error: string } }).data;
    expect(data.error).toMatch(/restarted/i);
    expect(data.error).toMatch(/deploy again/i);
  });

  /** LIVE rows are `restoreServices`'s business, and touching them here would
   *  mean a published app never came back after a restart. */
  it("leaves every other row alone", async () => {
    await service.reconcileDeployments();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "BUILDING" } }),
    );
  });
});
