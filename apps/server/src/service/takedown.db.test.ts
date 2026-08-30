import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** What a moderator's takedown actually reaches.
 *
 *  ACTIONED used to mean `visibility: PRIVATE` and nothing else, which this
 *  codebase documents as "a decision about who may read the source". So a
 *  project reported for MALWARE went on being served at its public deploy URL,
 *  one reported for SECRETS went on serving its source through its embed
 *  token, and the owner could publish it again in one request.
 *
 *  Four more surfaces were added later, from reading `takenDownAt`'s three
 *  call sites against the rest of the product: copying a project, redeeming
 *  its share link, its scheduled jobs, and deploying it again. The first two
 *  matter most — a fork produced an identical project with the column null,
 *  which is a guard defeated by a button, and the share link was the embed's
 *  twin with only one of the two ever closed.
 *
 *  These are database claims — a WHERE clause is either there or it is not —
 *  so they are checked against real rows.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// The teardown touches Docker and the filesystem. Stubbed, because the point
// of these tests is that the guarantee does NOT depend on it.
const unpublish = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./deployService.js", async () => {
  const actual = await vi.importActual<typeof import("./deployService.js")>(
    "./deployService.js",
  );
  return { ...actual, unpublish };
});

vi.mock("../middlewares/requireAdmin.js", () => ({
  adminEmails: () => new Set<string>(),
}));

// Nothing below should ever reach Docker: every assertion here is that a run
// was refused or never started. Mocked so that "it started a container" fails
// loudly rather than hanging.
const ensureContainer = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({ ensureContainer }));

describe.skipIf(!TEST_DATABASE_URL)("a moderator's takedown", () => {
  const scope = dbScope("takedown");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let reports: typeof import("./reportService.js");
  let embeds: typeof import("./embedService.js");
  let deploys: typeof import("./deployService.js");
  let access: typeof import("./projectAccessService.js");
  let projects: typeof import("./projectService.js");
  let jobs: typeof import("./scheduleService.js");
  let projectRoot: typeof import("../utils/projectPaths.js").projectRoot;
  let visibility: typeof import("../generated/prisma/enums.js").ProjectVisibility;

  let ownerId: string;
  let strangerId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    reports = await import("./reportService.js");
    embeds = await import("./embedService.js");
    deploys = await import("./deployService.js");
    access = await import("./projectAccessService.js");
    projects = await import("./projectService.js");
    jobs = await import("./scheduleService.js");
    ({ ProjectVisibility: visibility } = await import(
      "../generated/prisma/enums.js"
    ));
    ({ projectRoot } = await import("../utils/projectPaths.js"));
  });

  beforeEach(async () => {
    unpublish.mockReset().mockResolvedValue(undefined);
    ensureContainer.mockReset().mockRejectedValue(
      new Error("no run should have got this far"),
    );

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    const stranger = await prisma.user.create({
      data: { email: scope.email("stranger"), passwordHash: "x" },
    });
    ownerId = owner.id;
    strangerId = stranger.id;

    const project = await prisma.project.create({
      data: {
        name: "Malware",
        ownerId,
        template: "react-vite",
        visibility: "PUBLIC",
      },
    });
    projectId = project.id;

    // An embed lists the working tree, so there has to be one on disk.
    await mkdir(projectRoot(projectId), { recursive: true });
    await writeFile(path.join(projectRoot(projectId), "index.js"), "export {};");
  });

  afterEach(async () => {
    await rm(projectRoot(projectId), { recursive: true, force: true });
    await scope.cleanup(prisma);
  });

  /** Reports it and acts on it, the way the queue does. */
  const takeDown = async () => {
    const { id } = await reports.fileReport({
      projectId,
      reporterId: strangerId,
      reason: "MALWARE",
    });
    return reports.reviewReport({
      reportId: id,
      decision: "ACTIONED",
      reviewerEmail: "mod@example.com",
    });
  };

  /** A live deployment at a subdomain nobody else is using. */
  const publish = async (subdomain: string) =>
    prisma.deployment.create({
      data: {
        projectId,
        subdomain,
        status: "LIVE",
        kind: "STATIC",
        buildCommand: "npm run build",
        outputDir: "dist",
        deployedAt: new Date(),
      },
    });

  describe("the published site", () => {
    it("stops being served", async () => {
      const sub = `td-${Date.now().toString(36)}`;
      await publish(sub);
      expect(await deploys.resolveSite(`${sub}.localhost`)).toBeDefined();

      await takeDown();

      expect(await deploys.resolveSite(`${sub}.localhost`)).toBeUndefined();
    });

    it("stops being served even when the teardown fails", async () => {
      // The load-bearing one. `unpublish` removes files and stops a container,
      // so it can fail in ways a database cannot -- and a takedown that only
      // works when the cleanup worked is a takedown that usually works.
      const sub = `td-${Date.now().toString(36)}-x`;
      await publish(sub);
      unpublish.mockRejectedValue(new Error("docker is down"));

      await takeDown();

      expect(await deploys.resolveSite(`${sub}.localhost`)).toBeUndefined();
      // The row is still there, which is exactly why the query has to carry it.
      expect(
        await prisma.deployment.findUnique({ where: { projectId } }),
      ).not.toBeNull();
    });
  });

  describe("the embed", () => {
    it("stops resolving", async () => {
      const { token } = await embeds.createEmbed(projectId);
      expect(token).toBeTruthy();
      await expect(embeds.embedPayload(token!)).resolves.toBeDefined();

      await takeDown();

      await expect(embeds.embedPayload(token!)).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe("the owner", () => {
    it("cannot publish it again", async () => {
      await takeDown();

      await expect(
        access.setProjectVisibility(projectId, ownerId, visibility.PUBLIC),
      ).rejects.toMatchObject({ code: "TAKEN_DOWN" });
    });

    it("can still make it private, which was never the moderator's objection", async () => {
      await takeDown();

      await expect(
        access.setProjectVisibility(projectId, ownerId, visibility.PRIVATE),
      ).resolves.toBeDefined();
    });

    it("is unaffected on a project nobody took down", async () => {
      await expect(
        access.setProjectVisibility(projectId, ownerId, visibility.PUBLIC),
      ).resolves.toMatchObject({ visibility: "PUBLIC" });
    });
  });

  describe("copying it", () => {
    /** The one that made the other three guards irrelevant. All of them read
     *  `takenDownAt`, and a fork produced a project where it is null holding
     *  exactly the files that were reported. */
    it("cannot be forked", async () => {
      await takeDown();

      await expect(
        projects.forkProjectService(projectId, ownerId, "Malware again"),
      ).rejects.toMatchObject({ code: "TAKEN_DOWN" });

      expect(
        await prisma.project.count({ where: { forkedFromId: projectId } }),
      ).toBe(0);
    });

    it("cannot be duplicated", async () => {
      await takeDown();

      await expect(
        projects.duplicateProjectService(projectId, ownerId),
      ).rejects.toMatchObject({ code: "TAKEN_DOWN" });
    });

    /** The refusal has to be about the takedown and not about copying, or the
     *  fix would have removed a feature rather than closed a hole. */
    it("copies fine while nobody has taken it down", async () => {
      const copy = await projects.duplicateProjectService(projectId, ownerId);
      expect(copy.id).not.toBe(projectId);
      await rm(projectRoot(copy.id), { recursive: true, force: true });
    });
  });

  describe("the share link", () => {
    const linked = async () =>
      access.rotateShareToken(projectId, ownerId, "VIEWER");

    it("stops redeeming", async () => {
      const token = await linked();
      await takeDown();

      await expect(
        access.redeemShareToken(token, strangerId),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(
        await prisma.projectCollaborator.count({ where: { projectId } }),
      ).toBe(0);
    });

    /** The clause, not the cleanup. The token is also cleared when a moderator
     *  acts, but that is a write and writes fail; putting the row back here is
     *  the only way to test which of the two is load-bearing. */
    it("stops redeeming even if the token was never cleared", async () => {
      const token = await linked();
      await takeDown();
      await prisma.project.update({
        where: { id: projectId },
        data: { shareToken: token },
      });

      await expect(
        access.redeemShareToken(token, strangerId),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("is cleared by the takedown as well, like the embed beside it", async () => {
      await linked();
      await takeDown();

      const row = await prisma.project.findUnique({ where: { id: projectId } });
      expect(row?.shareToken).toBeNull();
    });

    it("still redeems for a project nobody took down", async () => {
      const token = await linked();

      await expect(
        access.redeemShareToken(token, strangerId),
      ).resolves.toMatchObject({ id: projectId });
    });
  });

  describe("its scheduled jobs", () => {
    const nightly = async () =>
      jobs.createJob(projectId, {
        name: "Backup",
        schedule: "30 2 * * *",
        command: "npm run backup",
      });

    /** The worst of the four: not who may read the project, but what this
     *  machine goes on doing on its behalf, on a schedule, with nothing in the
     *  product that would ever show it. */
    it("stop being swept", async () => {
      const due = new Date(Date.now() - 60_000);
      const job = await nightly();
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { nextRunAt: due },
      });

      await takeDown();

      const { finished } = await jobs.runDueJobs();
      await finished;

      // The claim, not the run. `runDueJobs` advances `nextRunAt` BEFORE
      // starting anything, so an untouched firing is the only evidence the
      // sweep never selected this job -- and it is the evidence that
      // distinguishes the two guards. The refusal inside `runJobNow` would
      // leave the run count at zero on its own, so asserting on that would
      // have each guard cover for the other and neither be tested.
      const row = await prisma.scheduledJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.nextRunAt?.getTime()).toBe(due.getTime());

      // Scoped to this job rather than read off the sweep's total, which
      // counts whatever else vitest is running in parallel -- how three
      // suites here came to pass for the wrong reason (2.17, 2.19).
      expect(
        await prisma.scheduledRun.count({ where: { jobId: job.id } }),
      ).toBe(0);
      expect(ensureContainer).not.toHaveBeenCalled();
    });

    /** Held, not cancelled. The row and its schedule survive, so lifting the
     *  takedown brings the job back rather than leaving the owner to notice
     *  their schedules were deleted on their behalf. */
    it("are held rather than deleted", async () => {
      const job = await nightly();
      await takeDown();

      const row = await prisma.scheduledJob.findUnique({ where: { id: job.id } });
      expect(row).not.toBeNull();
      expect(row?.enabled).toBe(true);
      expect(row?.schedule).toBe("30 2 * * *");
    });

    it("refuse to be run by hand either", async () => {
      const job = await nightly();
      await takeDown();

      await expect(jobs.runJobNow(job.id)).rejects.toMatchObject({
        code: "TAKEN_DOWN",
      });
      expect(ensureContainer).not.toHaveBeenCalled();
    });

    it("are swept as usual for a project nobody took down", async () => {
      const job = await nightly();
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { nextRunAt: new Date(Date.now() - 60_000) },
      });

      const { finished } = await jobs.runDueJobs();
      await finished;

      expect(
        await prisma.scheduledRun.count({ where: { jobId: job.id } }),
      ).toBe(1);
    });
  });

  describe("deploying it again", () => {
    /** The mildest of the four -- `resolveSite` refuses to serve whatever this
     *  built -- and still a container and a build spent on a site that 404s,
     *  after which the deploy panel reports a live deployment nobody can
     *  reach. */
    it("is refused at the door", async () => {
      await takeDown();

      await expect(deploys.publish(projectId)).rejects.toMatchObject({
        code: "TAKEN_DOWN",
      });
    });
  });

  describe("a dismissal", () => {
    it("takes nothing down", async () => {
      const sub = `td-${Date.now().toString(36)}-d`;
      await publish(sub);

      const { id } = await reports.fileReport({
        projectId,
        reporterId: strangerId,
        reason: "ABUSE",
      });
      await reports.reviewReport({
        reportId: id,
        decision: "DISMISSED",
        reviewerEmail: "mod@example.com",
      });

      expect(await deploys.resolveSite(`${sub}.localhost`)).toBeDefined();
      const row = await prisma.project.findUnique({ where: { id: projectId } });
      expect(row?.takenDownAt).toBeNull();
      expect(row?.visibility).toBe("PUBLIC");
    });
  });
});
