import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Scheduled jobs against real rows.
 *
 *  Three of the things this feature promises are properties of queries rather
 *  than of branches, and none of them can be faked into meaning anything:
 *
 *  - the sweeper claims a due job with a conditional update, which is what
 *    stops two sweeps from starting the same run;
 *  - a missed window produces ONE catch-up, because the next firing is
 *    recomputed from now rather than from the slot that was missed;
 *  - an overlapping firing is written as SKIPPED rather than started behind
 *    the one still going.
 *
 *  Docker is mocked. What is under test is what this code does with an exec's
 *  result, not whether a container runs a shell.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const ensureContainer = vi.hoisted(() => vi.fn());
const execCapture = vi.hoisted(() =>
  // Typed with the real parameters, not `() => ...`: the argv is what several
  // of these tests assert on, and a zero-arg signature makes `calls[0][1]` a
  // type error rather than the assertion it is meant to be.
  vi.fn<
    (
      container: unknown,
      argv: string[],
      options?: unknown,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  >(),
);

vi.mock("../containers/containerManager.js", () => ({ ensureContainer }));
vi.mock("../containers/execCapture.js", () => ({ execCapture }));

describe.skipIf(!TEST_DATABASE_URL)("scheduled jobs", () => {
  const scope = dbScope("schedules");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let jobs: typeof import("./scheduleService.js");

  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    jobs = await import("./scheduleService.js");
  });

  beforeEach(async () => {
    ensureContainer.mockReset();
    ensureContainer.mockResolvedValue({});
    execCapture.mockReset();
    execCapture.mockResolvedValue({ stdout: "done", stderr: "", exitCode: 0 });

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    const one = await prisma.project.create({
      data: { name: "Nightly", ownerId: owner.id },
    });
    const two = await prisma.project.create({
      data: { name: "Other", ownerId: owner.id },
    });
    projectId = one.id;
    otherProjectId = two.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  const NIGHTLY = { name: "Backup", schedule: "30 2 * * *", command: "npm run backup" };

  describe("keeping them", () => {
    it("stores the next firing rather than deriving it later", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);

      expect(job.nextRunAt).not.toBeNull();
      const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.nextRunAt?.toISOString()).toBe(job.nextRunAt);
    });

    /** A disabled job with a stored firing would be one index away from
     *  running: the sweeper's WHERE is what keeps it still, and a second guard
     *  is a guard that can be forgotten. So there is only one. */
    it("gives a disabled job no next firing at all", async () => {
      const job = await jobs.createJob(projectId, { ...NIGHTLY, enabled: false });

      expect(job.nextRunAt).toBeNull();
    });

    it("re-arms a job when it is enabled again", async () => {
      const job = await jobs.createJob(projectId, { ...NIGHTLY, enabled: false });

      const on = await jobs.updateJob(projectId, job.id, { enabled: true });

      expect(on.nextRunAt).not.toBeNull();
      expect(new Date(on.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });

    /** Enabling something whose stored firing is in the past must not make it
     *  instantly due — which is what carrying the old value forward would do,
     *  and it would look like the job running "for no reason". */
    it("does not leave a stale firing behind an enable", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { enabled: false, nextRunAt: new Date("2020-01-01T00:00:00Z") },
      });

      const on = await jobs.updateJob(projectId, job.id, { enabled: true });

      expect(new Date(on.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it("refuses more jobs than a project may hold", async () => {
      for (let index = 0; index < 10; index += 1) {
        await jobs.createJob(projectId, { ...NIGHTLY, name: `Backup ${String(index)}` });
      }

      await expect(jobs.createJob(projectId, NIGHTLY)).rejects.toMatchObject({
        code: "TOO_MANY_JOBS",
      });
    });

    it("counts that limit per project, not across the machine", async () => {
      for (let index = 0; index < 10; index += 1) {
        await jobs.createJob(projectId, { ...NIGHTLY, name: `Backup ${String(index)}` });
      }

      await expect(jobs.createJob(otherProjectId, NIGHTLY)).resolves.toMatchObject({
        name: "Backup",
      });
    });

    /** Every read and write takes a project id as well as a job id. Without
     *  that, an id guessed from another project is a job somebody else can
     *  edit, delete, and read the output of. */
    it("will not touch a job through another project", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);

      await expect(
        jobs.updateJob(otherProjectId, job.id, { name: "Mine now" }),
      ).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
      await expect(jobs.deleteJob(otherProjectId, job.id)).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
      await expect(jobs.listRuns(otherProjectId, job.id)).rejects.toMatchObject({
        code: "JOB_NOT_FOUND",
      });
    });

    it("takes the job's history with the job", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);
      await jobs.runJobNow(job.id);

      await jobs.deleteJob(projectId, job.id);

      expect(await prisma.scheduledRun.count({ where: { jobId: job.id } })).toBe(0);
    });

    it("lists a project's jobs with their most recent run", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);
      await jobs.runJobNow(job.id);

      const [listed] = await jobs.listJobs(projectId);

      expect(listed?.lastRun?.status).toBe("SUCCEEDED");
    });
  });

  describe("running one", () => {
    it("runs the command through a shell in the project's container", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);

      await jobs.runJobNow(job.id);

      expect(ensureContainer).toHaveBeenCalledWith(projectId);
      expect(execCapture.mock.calls[0]?.[1]).toEqual([
        "/bin/sh",
        "-lc",
        "npm run backup",
      ]);
    });

    it("records what it wrote and that it worked", async () => {
      execCapture.mockResolvedValue({ stdout: "12 files", stderr: "", exitCode: 0 });
      const job = await jobs.createJob(projectId, NIGHTLY);

      const run = await jobs.runJobNow(job.id);

      expect(run.status).toBe("SUCCEEDED");
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("12 files");
      expect(run.finishedAt).not.toBeNull();
    });

    it("keeps stderr, which is where the reason usually is", async () => {
      execCapture.mockResolvedValue({ stdout: "", stderr: "no such file", exitCode: 1 });
      const job = await jobs.createJob(projectId, NIGHTLY);

      const run = await jobs.runJobNow(job.id);

      expect(run.status).toBe("FAILED");
      expect(run.exitCode).toBe(1);
      expect(run.output).toContain("no such file");
    });

    /** "The machine could not run it" and "your command failed" are different
     *  sentences, and collapsing them sends somebody to debug a script that
     *  was never executed. */
    it("separates a job that could not start from one that failed", async () => {
      ensureContainer.mockRejectedValue(new Error("no capacity"));
      const job = await jobs.createJob(projectId, NIGHTLY);

      const run = await jobs.runJobNow(job.id);

      expect(run.status).toBe("ERRORED");
      expect(run.exitCode).toBeNull();
      expect(run.output).toContain("no capacity");
    });

    /** The tail, not the head: a build that fails writes its error on the last
     *  line and three thousand lines of progress before it. */
    it("truncates long output from the front", async () => {
      execCapture.mockResolvedValue({
        stdout: `${"x".repeat(40_000)}THE ERROR`,
        stderr: "",
        exitCode: 1,
      });
      const job = await jobs.createJob(projectId, NIGHTLY);

      const run = await jobs.runJobNow(job.id);

      expect(run.output).toContain("THE ERROR");
      expect(run.output).toContain("truncated");
      expect(run.output!.length).toBeLessThan(20_000);
    });

    /** A queue would turn a job slower than its own schedule into an unbounded
     *  backlog. Recorded rather than dropped, so the misconfiguration is
     *  visible in the history instead of looking like a job that stopped. */
    it("skips a firing whose predecessor has not finished", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);
      await prisma.scheduledRun.create({ data: { jobId: job.id, status: "RUNNING" } });

      const run = await jobs.runJobNow(job.id);

      expect(run.status).toBe("SKIPPED");
      expect(execCapture).not.toHaveBeenCalled();
    });

    it("keeps only the most recent runs", async () => {
      const job = await jobs.createJob(projectId, NIGHTLY);

      for (let index = 0; index < 23; index += 1) {
        await jobs.runJobNow(job.id);
      }

      expect(await prisma.scheduledRun.count({ where: { jobId: job.id } })).toBe(20);
    });
  });

  describe("the sweep", () => {
    async function due(overrides: Record<string, unknown> = {}): Promise<string> {
      const job = await jobs.createJob(projectId, NIGHTLY);
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { nextRunAt: new Date(Date.now() - 60_000), ...overrides },
      });
      return job.id;
    }

    it("starts a job whose time has passed", async () => {
      const id = await due();

      const { finished } = await jobs.runDueJobs();
      await finished;

      // This job's own runs, not the sweep's total. `runDueJobs` is global by
      // design, so `started` counts whatever every other suite happened to
      // leave due -- the fourth time a DB suite here has asserted on a global
      // query and passed on the schedule vitest chose (2.17, 2.19).
      expect(await prisma.scheduledRun.count({ where: { jobId: id } })).toBe(1);
    });

    it("leaves a job whose time has not come", async () => {
      const { id } = await jobs.createJob(projectId, NIGHTLY);

      await (await jobs.runDueJobs()).finished;

      expect(await prisma.scheduledRun.count({ where: { jobId: id } })).toBe(0);
    });

    it("leaves a disabled job alone even if its firing is in the past", async () => {
      const id = await due({ enabled: false });

      await (await jobs.runDueJobs()).finished;

      expect(await prisma.scheduledRun.count({ where: { jobId: id } })).toBe(0);
    });

    /** A server down for a day owes an hourly job twenty-four runs by the
     *  calendar. Running them is never what anybody wanted: the next firing is
     *  recomputed from now, so downtime costs one catch-up. */
    it("owes one catch-up for a missed day, not a day's worth", async () => {
      const job = await jobs.createJob(projectId, { ...NIGHTLY, schedule: "0 * * * *" });
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { nextRunAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      await (await jobs.runDueJobs()).finished;
      await (await jobs.runDueJobs()).finished;

      // Two sweeps, one run. Counted on this job, for the reason above.
      expect(await prisma.scheduledRun.count({ where: { jobId: job.id } })).toBe(1);

      const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    /** The claim is a conditional update on the firing the sweep read. Two
     *  sweeps racing — two servers, or an overlapping interval — and only the
     *  one that still matches wins. */
    it("is claimed once when two sweeps arrive together", async () => {
      const id = await due();

      const [first, second] = await Promise.all([jobs.runDueJobs(), jobs.runDueJobs()]);
      await Promise.all([first.finished, second.finished]);

      // The run count is the claim: `started` is a global total, and only one
      // of the two sweeps may have written a run for THIS job.
      expect(await prisma.scheduledRun.count({ where: { jobId: id } })).toBe(1);
    });

    /** Only reachable by editing the row outside the API, which is exactly the
     *  case that would otherwise retry a broken expression every minute for as
     *  long as the deployment lives. */
    it("disables a job whose expression stopped parsing", async () => {
      const id = await due({ schedule: "not a schedule" });

      await (await jobs.runDueJobs()).finished;

      const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id } });
      expect(row.enabled).toBe(false);
      expect(row.nextRunAt).toBeNull();
    });
  });
});
