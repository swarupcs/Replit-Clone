import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Reporting a public project, and reviewing what gets reported.
 *
 *  Against real rows, because almost everything worth proving here is a
 *  database guarantee rather than a branch: the unique index that stops one
 *  account burying the queue, the SetNull that keeps a report alive after its
 *  reporter deletes their account, and the transaction that must not leave a
 *  project private with its report still open.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("reporting a public project", () => {
  const scope = dbScope("reports");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let reports: typeof import("./reportService.js");

  let ownerId: string;
  let strangerId: string;
  let publicId: string;
  let privateId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    reports = await import("./reportService.js");
  });

  /** The queue, restricted to this suite's own rows.
   *
   *  `listReports` is global, as the operator's queue has to be — so asserting
   *  on its length couples this file to whatever else is running. It also caps
   *  at a page, which is why the narrowing is an argument rather than a
   *  `.filter()` on the result: past that page this suite's rows never reach a
   *  filter at all, and the suite reports "nothing here" instead of failing
   *  honestly. Fifth instance of the same mistake in this codebase.
   *
   *  Returns the items and drops the cursor: every assertion below is about
   *  one narrow query that fits on a page, and the paging itself is tested
   *  where it lives.
   */
  const queue = async (
    status: Parameters<typeof reports.listReports>[0],
    projectId: string = publicId,
  ) => (await reports.listReports(status, projectId)).items;

  beforeEach(async () => {
    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    const stranger = await prisma.user.create({
      data: { email: scope.email("stranger"), passwordHash: "x" },
    });
    ownerId = owner.id;
    strangerId = stranger.id;

    const open = await prisma.project.create({
      data: {
        name: "Published",
        ownerId,
        template: "react-vite",
        visibility: "PUBLIC",
      },
    });
    const shut = await prisma.project.create({
      data: { name: "Unpublished", ownerId, template: "react-vite" },
    });
    publicId = open.id;
    privateId = shut.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  describe("filing one", () => {
    it("records the report against the project", async () => {
      const { id } = await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "SECRETS",
        details: "  There is an AWS key in .env  ",
      });

      const row = await prisma.projectReport.findUniqueOrThrow({
        where: { id },
      });
      expect(row.projectId).toBe(publicId);
      expect(row.reporterId).toBe(strangerId);
      expect(row.reason).toBe("SECRETS");
      expect(row.status).toBe("OPEN");
      expect(row.details).toBe("There is an AWS key in .env");
    });

    it("stores nothing for an empty description", async () => {
      const { id } = await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "OTHER",
        details: "   ",
      });

      const row = await prisma.projectReport.findUniqueOrThrow({
        where: { id },
      });
      expect(row.details).toBeNull();
    });

    /** A private project has no audience to protect and nothing a stranger
     *  could have seen to object to. Answered as "not found" rather than as
     *  "not public", because the other answer tells anybody holding an id
     *  whether a private project exists — which is what PRIVATE is for. */
    it("will not report a project that is not public", async () => {
      await expect(
        reports.fileReport({
          projectId: privateId,
          reporterId: strangerId,
          reason: "ABUSE",
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_PUBLIC" });
    });

    it("answers a project that does not exist the same way", async () => {
      await expect(
        reports.fileReport({
          projectId: "8a7d2f19-0000-4000-8000-000000000000",
          reporterId: strangerId,
          reason: "ABUSE",
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "NOT_PUBLIC" });
    });

    it("sends an owner to the button they already have", async () => {
      await expect(
        reports.fileReport({
          projectId: publicId,
          reporterId: ownerId,
          reason: "ABUSE",
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "OWN_PROJECT" });
    });

    /** The queue is the scarce resource here, not the database. One account
     *  filing the same complaint a thousand times would bury every other
     *  report on the page. */
    it("takes one report per person per project", async () => {
      await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "ABUSE",
      });

      await expect(
        reports.fileReport({
          projectId: publicId,
          reporterId: strangerId,
          reason: "MALWARE",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REPORTED" });
    });

    it("takes one even when both arrive at once", async () => {
      // The check before the insert cannot settle this on its own: both calls
      // can read "no existing report" before either writes one. What settles
      // it is the unique index, and the point of the test is that losing that
      // race is a 409 rather than a 500 -- the loser did nothing wrong, and an
      // unhandled constraint error would be the API breaking its own guarantee
      // by crashing instead of admitting it.
      const outcomes = await Promise.allSettled([
        reports.fileReport({
          projectId: publicId,
          reporterId: strangerId,
          reason: "ABUSE",
        }),
        reports.fileReport({
          projectId: publicId,
          reporterId: strangerId,
          reason: "MALWARE",
        }),
      ]);

      const kept = outcomes.filter((o) => o.status === "fulfilled");
      const refused = outcomes.filter((o) => o.status === "rejected");

      expect(kept).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        reason: { statusCode: 409, code: "ALREADY_REPORTED" },
      });
      expect(await queue("OPEN")).toHaveLength(1);
    });

    it("still takes a second person's", async () => {
      const third = await prisma.user.create({
        data: { email: scope.email("third"), passwordHash: "x" },
      });

      await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "ABUSE",
      });
      await reports.fileReport({
        projectId: publicId,
        reporterId: third.id,
        reason: "MALWARE",
      });

      expect(await queue("OPEN")).toHaveLength(2);
    });

    it("refuses a description longer than the cap", async () => {
      await expect(
        reports.fileReport({
          projectId: publicId,
          reporterId: strangerId,
          reason: "OTHER",
          details: "x".repeat(reports.MAX_DETAILS + 1),
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: "DETAILS_TOO_LONG" });
    });
  });

  describe("the queue", () => {
    it("shows who reported what, and about whose project", async () => {
      await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "SECRETS",
      });

      const [entry] = await queue("OPEN");
      expect(entry?.projectName).toBe("Published");
      expect(entry?.ownerEmail).toContain("owner-");
      expect(entry?.reporterEmail).toContain("stranger-");
      expect(entry?.status).toBe("OPEN");
    });

    /** A report outlives the account that filed it. Deleting your account must
     *  not quietly withdraw a complaint nobody has acted on yet — but the
     *  report must stop naming you. */
    it("keeps a report whose reporter deleted their account", async () => {
      const { id } = await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "SECRETS",
      });

      await prisma.user.delete({ where: { id: strangerId } });

      const kept = await reports.findReport(id);
      expect(kept?.status).toBe("OPEN");
      expect(kept?.reporterEmail).toBeNull();
    });

    it("goes with the project when the project goes", async () => {
      const { id } = await reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason: "SECRETS",
      });

      await prisma.project.delete({ where: { id: publicId } });

      expect(await reports.findReport(id)).toBeNull();
    });
  });

  describe("reviewing one", () => {
    async function filed(reason: "ABUSE" | "SECRETS" = "ABUSE") {
      return reports.fileReport({
        projectId: publicId,
        reporterId: strangerId,
        reason,
      });
    }

    /** The only authority this grants. An operator can take a project out of
     *  the gallery; they cannot delete it, edit it, or touch the account. */
    it("makes the project private when actioned", async () => {
      const { id } = await filed();

      const reviewed = await reports.reviewReport({
        reportId: id,
        decision: "ACTIONED",
        reviewerEmail: "ops@example.com",
      });

      expect(reviewed.status).toBe("ACTIONED");
      expect(reviewed.reviewedBy).toBe("ops@example.com");

      const project = await prisma.project.findUniqueOrThrow({
        where: { id: publicId },
      });
      expect(project.visibility).toBe("PRIVATE");
    });

    it("leaves the project alone when dismissed", async () => {
      const { id } = await filed();

      await reports.reviewReport({
        reportId: id,
        decision: "DISMISSED",
        reviewerEmail: "ops@example.com",
      });

      const project = await prisma.project.findUniqueOrThrow({
        where: { id: publicId },
      });
      expect(project.visibility).toBe("PUBLIC");
    });

    /** Everybody else who reported this project reported the thing that has
     *  just been dealt with. Left open, a project reported by nine people
     *  sits in the queue eight more times after it is already private. */
    it("closes the other open reports about the same project", async () => {
      const third = await prisma.user.create({
        data: { email: scope.email("third"), passwordHash: "x" },
      });

      const { id } = await filed();
      await reports.fileReport({
        projectId: publicId,
        reporterId: third.id,
        reason: "MALWARE",
      });

      await reports.reviewReport({
        reportId: id,
        decision: "ACTIONED",
        reviewerEmail: "ops@example.com",
      });

      expect(await queue("OPEN")).toHaveLength(0);
      expect(await queue("ACTIONED")).toHaveLength(2);
    });

    /** A dismissal speaks only for the report it was made about. Two people
     *  can object for different reasons, and finding one baseless says nothing
     *  about the other. */
    it("does not close anybody else's report on a dismissal", async () => {
      const third = await prisma.user.create({
        data: { email: scope.email("third"), passwordHash: "x" },
      });

      const { id } = await filed();
      await reports.fileReport({
        projectId: publicId,
        reporterId: third.id,
        reason: "MALWARE",
      });

      await reports.reviewReport({
        reportId: id,
        decision: "DISMISSED",
        reviewerEmail: "ops@example.com",
      });

      expect(await queue("OPEN")).toHaveLength(1);
    });

    /** The bulk close is scoped to one project, and that scope is the only
     *  thing between "resolve this complaint" and "empty the queue". A
     *  `updateMany` missing its projectId would look identical from inside a
     *  suite that only ever reports one project. */
    it("does not touch reports about a different project", async () => {
      const second = await prisma.project.create({
        data: {
          name: "Also published",
          ownerId,
          template: "react-vite",
          visibility: "PUBLIC",
        },
      });

      const { id } = await filed();
      await reports.fileReport({
        projectId: second.id,
        reporterId: strangerId,
        reason: "MALWARE",
      });

      await reports.reviewReport({
        reportId: id,
        decision: "ACTIONED",
        reviewerEmail: "ops@example.com",
      });

      // This project's own queue is empty, and the other project's is not.
      expect(await queue("OPEN")).toHaveLength(0);
      const open = await queue("OPEN", second.id);
      expect(open).toHaveLength(1);
      expect(open[0]?.projectId).toBe(second.id);

      // And the other project is still public, which is the half that would
      // hurt: un-publishing somebody's project on somebody else's complaint.
      const untouched = await prisma.project.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(untouched.visibility).toBe("PUBLIC");
    });

    it("refuses to review the same report twice", async () => {
      const { id } = await filed();
      await reports.reviewReport({
        reportId: id,
        decision: "DISMISSED",
        reviewerEmail: "ops@example.com",
      });

      await expect(
        reports.reviewReport({
          reportId: id,
          decision: "ACTIONED",
          reviewerEmail: "ops@example.com",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ALREADY_REVIEWED" });
    });

    it("refuses a report that does not exist", async () => {
      await expect(
        reports.reviewReport({
          reportId: "8a7d2f19-0000-4000-8000-000000000000",
          decision: "ACTIONED",
          reviewerEmail: "ops@example.com",
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: "REPORT_NOT_FOUND" });
    });

    /** Un-publishing is the remedy for having published, so an owner can
     *  always undo this themselves. Which is the point of it being the only
     *  power an operator has: its mistakes are reversible by the person they
     *  were made against. */
    it("leaves the owner able to publish again", async () => {
      const { id } = await filed();
      await reports.reviewReport({
        reportId: id,
        decision: "ACTIONED",
        reviewerEmail: "ops@example.com",
      });

      await prisma.project.update({
        where: { id: publicId },
        data: { visibility: "PUBLIC" },
      });

      // And it can be reported again, because the earlier report is closed.
      await expect(
        reports.fileReport({
          projectId: publicId,
          reporterId: strangerId,
          reason: "ABUSE",
        }),
      ).rejects.toMatchObject({ code: "ALREADY_REPORTED" });
    });
  });
});
