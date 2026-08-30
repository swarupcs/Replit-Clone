import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** The moderation trail, and the appeal that answers it.
 *
 *  Against real rows, because the claims are about the record: that a decision
 *  and its entry commit together, that the trail outlives the project it is
 *  about, and that an owner cannot file appeals without limit.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// The takedown's teardown touches Docker and the filesystem, and none of that
// is what these tests are about.
const unpublish = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./deployService.js", async () => {
  const actual = await vi.importActual<typeof import("./deployService.js")>(
    "./deployService.js",
  );
  return { ...actual, unpublish };
});

const adminSet = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock("../middlewares/requireAdmin.js", () => ({
  adminEmails: () => adminSet.value,
}));

describe.skipIf(!TEST_DATABASE_URL)("the moderation trail", () => {
  const scope = dbScope("moderation-log");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let reports: typeof import("./reportService.js");
  let log: typeof import("./moderationLogService.js");

  let ownerId: string;
  let strangerId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    reports = await import("./reportService.js");
    log = await import("./moderationLogService.js");
  });

  beforeEach(async () => {
    unpublish.mockReset().mockResolvedValue(undefined);
    adminSet.value = new Set<string>();

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
        name: "Reported",
        ownerId,
        template: "react-vite",
        visibility: "PUBLIC",
      },
    });
    projectId = project.id;
  });

  afterEach(async () => {
    // Cleanup first, orphans second. Deleting the users cascades to their
    // projects, and the trail's SetNull is what strands its rows -- so a sweep
    // that ran before the cascade would leave behind exactly the rows the
    // cascade was about to create, for the next test to trip over.
    await scope.cleanup(prisma);
    await prisma.moderationAction.deleteMany({ where: { projectId: null } });
  });

  /** One report and its decision. Takes the reporter, because the queue's
   *  unique index means the same person cannot report one project twice --
   *  which is the behaviour under test elsewhere, not something to work
   *  around here. */
  const decide = async (
    decision: "ACTIONED" | "DISMISSED",
    reporterId = strangerId,
  ) => {
    const { id } = await reports.fileReport({
      projectId,
      reporterId,
      reason: "MALWARE",
    });
    return reports.reviewReport({
      reportId: id,
      decision,
      reviewerEmail: "mod@example.com",
    });
  };

  describe("recording a decision", () => {
    it("records who acted, and on which report", async () => {
      const report = await decide("ACTIONED");

      const trail = await log.listModerationActions(projectId);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: "ACTIONED",
        actor: "mod@example.com",
        reportId: report.id,
        projectName: "Reported",
      });
    });

    it("records a dismissal too", async () => {
      // A moderator who looks and finds nothing has done something worth being
      // able to show they did.
      await decide("DISMISSED");

      const trail = await log.listModerationActions(projectId);
      expect(trail[0]).toMatchObject({ action: "DISMISSED" });
    });

    it("survives the project being deleted", async () => {
      // A trail that vanishes with its subject can be erased by deleting the
      // subject, which is the move it exists to make visible.
      await decide("ACTIONED");
      await prisma.project.delete({ where: { id: projectId } });

      const rows = await prisma.moderationAction.findMany({
        where: { projectName: "Reported" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.projectId).toBeNull();
      expect(rows[0]?.actor).toBe("mod@example.com");
    });
  });

  describe("appealing", () => {
    it("is refused on a project nobody took down", async () => {
      await expect(
        log.appealTakedown({ projectId, ownerId, text: "please" }),
      ).rejects.toMatchObject({ code: "NOT_TAKEN_DOWN" });
    });

    it("is the owner's alone", async () => {
      await decide("ACTIONED");

      await expect(
        log.appealTakedown({ projectId, ownerId: strangerId, text: "please" }),
      ).rejects.toMatchObject({ code: "NOT_OWNER" });
    });

    it("lands in the same trail, in order", async () => {
      await decide("ACTIONED");
      await log.appealTakedown({
        projectId,
        ownerId,
        text: "It is a test fixture, not malware.",
      });

      const trail = await log.listModerationActions(projectId);
      expect(trail.map((row) => row.action)).toEqual(["ACTIONED", "APPEALED"]);
      expect(trail[1]?.reason).toContain("test fixture");
    });

    it("refuses a second one while the first is open", async () => {
      // An appeal is a message to a human who may be the only operator here.
      await decide("ACTIONED");
      await log.appealTakedown({ projectId, ownerId, text: "first" });

      await expect(
        log.appealTakedown({ projectId, ownerId, text: "second" }),
      ).rejects.toMatchObject({ code: "ALREADY_APPEALED" });
    });

    it("allows one against a NEW takedown after a reinstatement", async () => {
      // A project taken down, put back, and taken down again is a new case,
      // and the owner is entitled to answer it.
      await decide("ACTIONED");
      await log.appealTakedown({ projectId, ownerId, text: "first" });
      await log.reinstateProject({
        projectId,
        actor: "mod@example.com",
        reason: "Mistake",
      });

      await prisma.project.update({
        where: { id: projectId },
        data: { visibility: "PUBLIC" },
      });

      const second = await prisma.user.create({
        data: { email: scope.email("second-reporter"), passwordHash: "x" },
      });
      await decide("ACTIONED", second.id);

      await expect(
        log.appealTakedown({ projectId, ownerId, text: "second" }),
      ).resolves.toMatchObject({ action: "APPEALED" });
    });
  });

  describe("reinstating", () => {
    it("lifts the takedown and says who did it and why", async () => {
      await decide("ACTIONED");

      await log.reinstateProject({
        projectId,
        actor: "mod@example.com",
        reason: "The reporter was mistaken.",
      });

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });
      expect(project?.takenDownAt).toBeNull();

      const trail = await log.listModerationActions(projectId);
      expect(trail.at(-1)).toMatchObject({
        action: "REINSTATED",
        actor: "mod@example.com",
        reason: "The reporter was mistaken.",
      });
    });

    it("does NOT publish it again", async () => {
      // Reinstating restores the owner's control of that switch. What to do
      // with it is theirs to decide.
      await decide("ACTIONED");
      await log.reinstateProject({
        projectId,
        actor: "mod@example.com",
        reason: "Mistake",
      });

      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });
      expect(project?.visibility).toBe("PRIVATE");
    });

    it("insists on a reason", async () => {
      // "We put it back" with no account of why is the half of the record that
      // makes the other half unfalsifiable.
      await decide("ACTIONED");

      await expect(
        log.reinstateProject({ projectId, actor: "mod@example.com", reason: "  " }),
      ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    });

    it("is refused on a project nobody took down", async () => {
      await expect(
        log.reinstateProject({ projectId, actor: "mod@example.com", reason: "x" }),
      ).rejects.toMatchObject({ code: "NOT_TAKEN_DOWN" });
    });
  });
});
