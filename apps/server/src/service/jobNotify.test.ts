import { beforeEach, describe, expect, it, vi } from "vitest";

/** When a scheduled job tells its owner something, and — mostly — when it does
 *  not.
 *
 *  This is the rule the whole notification feature turns on, and it is the one
 *  a reasonable person implements the other way round: notify on failure. A job
 *  that fails every night for a month is ONE piece of news, not thirty. Mailing
 *  each one is how a notification somebody needed becomes a filter rule, which
 *  restores the silence the feature was built to end and hides that it has.
 */

/** Typed with its real parameter: `vi.fn(() => ...)` gives `mock.calls[0]` a
 *  zero-length tuple, which turns every assertion about WHAT the owner was
 *  told into a type error instead of a test. */
const notify = vi.hoisted(() =>
  vi.fn(
    (_input: {
      userId: string;
      kind: string;
      title: string;
      body: string;
      link?: string;
    }) => Promise.resolve("n1"),
  ),
);
vi.mock("./notificationService.js", () => ({ notify, notifyAdmins: vi.fn() }));

const jobFindUnique = vi.hoisted(() => vi.fn());
const runFindFirst = vi.hoisted(() => vi.fn());
const runCreate = vi.hoisted(() => vi.fn());
const runUpdate = vi.hoisted(() => vi.fn());
const runFindMany = vi.hoisted(() => vi.fn());
const runDeleteMany = vi.hoisted(() => vi.fn());
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

import { runJobNow } from "./scheduleService.js";

const JOB = {
  id: "j1",
  projectId: "p1",
  name: "Nightly backup",
  command: "npm run backup",
};

/** The job's last verdict before this run, or null for a job that has never
 *  said anything about its command. */
function previously(status: string | null) {
  runFindFirst.mockImplementation((args: { where: { status?: unknown } }) =>
    Promise.resolve(
      // The RUNNING lookup is the overlap check; the other is `lastVerdict`.
      args.where.status === "RUNNING"
        ? null
        : status
          ? { status }
          : null,
    ),
  );
}

/** What the command does on this run. */
function exits(code: number) {
  execCapture.mockResolvedValue({ exitCode: code, stdout: "", stderr: "" });
}

beforeEach(() => {
  notify.mockReset().mockResolvedValue("n1");
  jobFindUnique.mockReset().mockResolvedValue(JOB);
  runCreate.mockReset().mockResolvedValue({ id: "r1", status: "RUNNING" });
  runUpdate.mockReset().mockImplementation((args: { data: unknown }) =>
    Promise.resolve({ id: "r1", startedAt: new Date(), ...(args.data as object) }),
  );
  runFindMany.mockReset().mockResolvedValue([]);
  runDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  projectFindUnique.mockReset().mockResolvedValue({
    ownerId: "u1",
    name: "My project",
  });
  execCapture.mockReset();
});

describe("a job that starts failing", () => {
  it("tells the owner once, on the change", async () => {
    previously("SUCCEEDED");
    exits(1);

    await runJobNow("j1");

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      userId: "u1",
      kind: "JOB_FAILING",
    });
  });

  it("says nothing on the second consecutive failure", async () => {
    // The whole point. Thirty nights of failure is one piece of news.
    previously("FAILED");
    exits(1);

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });

  it("tells the owner when the very first run fails", async () => {
    // No previous verdict to change from, but somebody has just set this up
    // and it does not work, which is the most useful moment to say so.
    previously(null);
    exits(1);

    await runJobNow("j1");

    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: "JOB_FAILING" });
  });
});

describe("a job that recovers", () => {
  it("tells the owner, because that is news too", async () => {
    previously("FAILED");
    exits(0);

    await runJobNow("j1");

    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: "JOB_RECOVERED" });
  });

  it("says nothing when it was working all along", async () => {
    previously("SUCCEEDED");
    exits(0);

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing on a first run that succeeds", async () => {
    previously(null);
    exits(0);

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("outcomes that are not verdicts on the command", () => {
  /** These two found a real defect rather than confirming a design.
   *
   *  `withTimeout` used to resolve "timeout" when the work REJECTED, so an
   *  exec that threw was recorded as TIMED_OUT and told the owner the command
   *  "may still be running inside the container" when it was not running
   *  anywhere. ERRORED was reachable only if `ensureContainer` threw.
   *
   *  Harmless-looking until something is listening: with notifications on, an
   *  hour of Docker being down mails every owner on the machine to say their
   *  job is failing -- which is false, and the fastest way to teach people
   *  that this channel is noise.
   */
  it("does not treat a machine failure as the job breaking", async () => {
    // ERRORED means the container could not be started -- Docker down, no
    // capacity. A week of that must not read as a week of the backup being
    // broken, which is a different problem with a different fix.
    previously("SUCCEEDED");
    execCapture.mockRejectedValue(new Error("docker is down"));

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not let a machine failure cancel a real one either", async () => {
    // Having last ERRORED does not mean the command was working. A failure
    // after it is still the first failure, and still news.
    previously("FAILED");
    execCapture.mockRejectedValue(new Error("docker is down"));

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing when a run is skipped for overlapping", async () => {
    runFindFirst.mockResolvedValue({ id: "in-flight" });
    runCreate.mockResolvedValue({
      id: "r2",
      status: "SKIPPED",
      startedAt: new Date(),
      finishedAt: new Date(),
      exitCode: null,
      output: "The previous run had not finished.",
    });

    await runJobNow("j1");

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("what the owner is told", () => {
  it("links to the jobs panel of the right project", async () => {
    previously("SUCCEEDED");
    exits(1);

    await runJobNow("j1");

    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      link: "/project/p1?view=jobs",
    });
  });

  it("promises not to say it again, so silence afterwards means unchanged", async () => {
    previously("SUCCEEDED");
    exits(1);

    await runJobNow("j1");

    expect(String(notify.mock.calls[0]?.[0]?.body)).toContain(
      "not be told again until it changes",
    );
  });
});
