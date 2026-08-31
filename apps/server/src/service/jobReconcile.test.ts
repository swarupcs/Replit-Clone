import { beforeEach, describe, expect, it, vi } from "vitest";

/** What happens to a run this process started and did not live to finish.
 *
 *  The defect this covers is the worst kind there is: silent, permanent, and
 *  reached by deploying. `runJobNow` writes a RUNNING row before it starts;
 *  nothing ever cleared one the process did not come back to; the overlap
 *  check had no age bound, so from the next firing onwards every run wrote
 *  SKIPPED — and SKIPPED is deliberately not a verdict, so the notification
 *  system built to make exactly this visible stayed quiet about it forever.
 *
 *  Two guards, on purpose, and §6 decision 13 says why: the boot reconcile is
 *  cleanup that touches rows and can be missed, and the clause in the overlap
 *  query is the guarantee.
 */

const notify = vi.hoisted(() => vi.fn(() => Promise.resolve("n1")));
vi.mock("./notificationService.js", () => ({ notify, notifyAdmins: vi.fn() }));

const jobFindUnique = vi.hoisted(() => vi.fn());
const runFindFirst = vi.hoisted(() => vi.fn());
const runCreate = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runFindMany = vi.hoisted(() => vi.fn());
const runDeleteMany = vi.hoisted(() => vi.fn());
const runUpdateMany = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    scheduledJob: { findUnique: jobFindUnique },
    scheduledRun: {
      findFirst: runFindFirst,
      create: runCreate,
      update: runUpdate,
      findMany: runFindMany,
      deleteMany: runDeleteMany,
      updateMany: runUpdateMany,
    },
    project: { findUnique: projectFindUnique },
  },
}));

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn(() => Promise.resolve({ id: "c1" })),
}));
vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileJobRuns, runJobNow } from "./scheduleService.js";

const JOB = {
  id: "j1",
  projectId: "p1",
  name: "Nightly backup",
  command: "npm run backup",
  project: { takenDownAt: null },
};

/** The `where` the overlap check was made with, which is the whole assertion
 *  in this file: an unbounded one is the bug. */
function overlapWhere(): { status?: string; startedAt?: { gte?: Date } } {
  const call = runFindFirst.mock.calls.find(
    (args) => (args[0] as { where: { status?: string } }).where.status === "RUNNING",
  );
  return (call?.[0] as { where: { status?: string; startedAt?: { gte?: Date } } }).where;
}

beforeEach(() => {
  notify.mockReset().mockResolvedValue("n1");
  jobFindUnique.mockReset().mockResolvedValue(JOB);
  runFindFirst.mockReset().mockResolvedValue(null);
  runCreate.mockReset().mockImplementation((args: { data: unknown }) =>
    Promise.resolve({
      id: "r1",
      startedAt: new Date(),
      finishedAt: null,
      exitCode: null,
      output: null,
      ...(args.data as object),
    }),
  );
  runUpdate.mockReset().mockImplementation((args: { data: unknown }) =>
    Promise.resolve({ id: "r1", startedAt: new Date(), ...(args.data as object) }),
  );
  runFindMany.mockReset().mockResolvedValue([]);
  runDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  runUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  projectFindUnique.mockReset().mockResolvedValue({ ownerId: "u1", name: "My project" });
  execCapture.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("at boot", () => {
  it("names every run the last process was in the middle of", async () => {
    runUpdateMany.mockResolvedValue({ count: 2 });

    expect(await reconcileJobRuns()).toBe(2);
    expect(runUpdateMany).toHaveBeenCalledWith({
      where: { status: "RUNNING" },
      data: expect.objectContaining({ status: "ABANDONED" }),
    });
  });

  /** ABANDONED and not ERRORED. ERRORED says the machine never got the
   *  command started; this one started, and may have completed all of its
   *  work a second before the restart landed on it. Saying "we could not run
   *  it" about a backup that in fact ran is the same lie TIMED_OUT exists to
   *  avoid, and it changes what the owner should do next. */
  it("says that what the command managed to do is not known", async () => {
    runUpdateMany.mockResolvedValue({ count: 1 });
    await reconcileJobRuns();

    const data = (
      runUpdateMany.mock.calls[0]?.[0] as { data: { output: string; finishedAt: Date } }
    ).data;
    expect(data.output).toMatch(/not recorded/i);
    // A run with no `finishedAt` is how this codebase shows one still going.
    // Leaving it null would swap an eternal RUNNING for an eternal in-flight.
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it("is quiet when nothing was interrupted", async () => {
    expect(await reconcileJobRuns()).toBe(0);
  });
});

describe("the overlap check", () => {
  /** Without this bound, a row from a process that is gone holds its job
   *  hostage forever: the sweep claims the job, finds the immortal RUNNING
   *  row, and writes SKIPPED every night until somebody notices by hand. */
  it("does not believe a RUNNING row of any age", async () => {
    await runJobNow("j1");

    const where = overlapWhere();
    expect(where.startedAt?.gte).toBeInstanceOf(Date);
    expect(Date.now() - (where.startedAt?.gte as Date).getTime()).toBeGreaterThan(0);
  });

  it("still refuses to start a second copy of a run in progress", async () => {
    // The bound must not undo the reason the check exists. A job slower than
    // its own schedule is recorded, never queued behind itself.
    runFindFirst.mockImplementation((args: { where: { status?: string } }) =>
      Promise.resolve(args.where.status === "RUNNING" ? { id: "old" } : null),
    );

    const run = await runJobNow("j1");

    expect(run.status).toBe("SKIPPED");
    expect(execCapture).not.toHaveBeenCalled();
  });

  /** The self-healing half: a stale row is not merely ignored, it is named,
   *  so the history reads as what happened rather than showing a run that is
   *  eternally in progress. */
  it("names the stale row it stepped over", async () => {
    await runJobNow("j1");

    expect(runUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        jobId: "j1",
        status: "RUNNING",
        startedAt: { lt: expect.any(Date) },
      }),
      data: expect.objectContaining({ status: "ABANDONED" }),
    });
  });

  /** ABANDONED is not a verdict, so a job that runs normally next time says
   *  nothing at all — the restart was the platform's problem, not news about
   *  somebody's command. */
  it("does not tell the owner their job is failing", async () => {
    runUpdateMany.mockResolvedValue({ count: 1 });
    await reconcileJobRuns();

    expect(notify).not.toHaveBeenCalled();
  });
});
