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

describe.skipIf(!TEST_DATABASE_URL)("a moderator's takedown", () => {
  const scope = dbScope("takedown");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let reports: typeof import("./reportService.js");
  let embeds: typeof import("./embedService.js");
  let deploys: typeof import("./deployService.js");
  let access: typeof import("./projectAccessService.js");
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
    ({ ProjectVisibility: visibility } = await import(
      "../generated/prisma/enums.js"
    ));
    ({ projectRoot } = await import("../utils/projectPaths.js"));
  });

  beforeEach(async () => {
    unpublish.mockReset().mockResolvedValue(undefined);

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
