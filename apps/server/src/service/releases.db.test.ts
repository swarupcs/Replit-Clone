import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Deployment history, and going back to a build.
 *
 *  Against real rows and real files, because the claim is about both: that the
 *  previous build's bytes are still there, and that going back to it is a
 *  pointer move rather than a rebuild. A rollback that rebuilt from source
 *  would publish whatever the tree says today, which is not what anybody means
 *  by going back — and only reading the served file can tell the difference.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("deployment releases", () => {
  const scope = dbScope("releases");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let deployService: typeof import("./deployService.js");
  let releases: typeof import("./releaseService.js");
  let projectRoot: typeof import("../utils/projectPaths.js").projectRoot;

  let ownerId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    deployService = await import("./deployService.js");
    releases = await import("./releaseService.js");
    ({ projectRoot } = await import("../utils/projectPaths.js"));
  });

  beforeEach(async () => {
    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    ownerId = owner.id;

    const project = await prisma.project.create({
      // static-html publishes the tree itself, so a publish needs no toolchain.
      data: { name: "Site", ownerId, template: "static-html" },
    });
    projectId = project.id;

    await mkdir(projectRoot(projectId), { recursive: true });
    await write("<h1>version one</h1>");
  });

  afterEach(async () => {
    await deployService.unpublish(projectId).catch(() => undefined);
    await scope.cleanup(prisma);
  });

  const write = (html: string) =>
    writeFile(path.join(projectRoot(projectId), "index.html"), html);

  /** What a visitor would actually be served right now. */
  const servedHtml = async (subdomain: string) => {
    const site = await deployService.resolveSite(`${subdomain}.localhost`);
    if (!site) throw new Error("not served");
    return readFile(path.join(site.root, "index.html"), "utf8");
  };

  describe("keeping the history", () => {
    it("records a release per publish, newest first", async () => {
      const first = await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      await deployService.publish(projectId);

      const list = await releases.listReleases(projectId);

      expect(list).toHaveLength(2);
      expect(list[0]?.live).toBe(true);
      expect(list[1]?.live).toBe(false);
      expect(first.subdomain).toBeTruthy();
    });

    it("keeps each build's own files rather than overwriting them", async () => {
      // The whole basis of a rollback. Before releases, publishing renamed a
      // staging directory over the live one and the previous build was gone.
      await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      const second = await deployService.publish(projectId);

      const list = await releases.listReleases(projectId);
      const older = list[1]!;

      const kept = await readFile(
        path.join(releases.releaseDirectory(second.subdomain, older.id), "index.html"),
        "utf8",
      );
      expect(kept).toBe("<h1>version one</h1>");
    });

    it("records what each build actually ran", async () => {
      // A template whose defaults change later must not rewrite history.
      await deployService.publish(projectId);

      const [release] = await releases.listReleases(projectId);
      expect(release?.outputDir).toBe(".");
      expect(release?.kind).toBe("static");
    });
  });

  describe("rolling back", () => {
    it("serves the earlier build's bytes again", async () => {
      const first = await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      await deployService.publish(projectId);

      expect(await servedHtml(first.subdomain)).toBe("<h1>version two</h1>");

      const list = await releases.listReleases(projectId);
      await releases.rollbackTo(projectId, list[1]!.id);

      // Not "a rebuild of the tree", which still says version two -- the actual
      // bytes the first build produced.
      expect(await servedHtml(first.subdomain)).toBe("<h1>version one</h1>");
    });

    it("does not rebuild, so the working tree is irrelevant", async () => {
      await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      const second = await deployService.publish(projectId);

      // The tree moves on again, to something never published at all.
      await write("<h1>unpublished work in progress</h1>");

      const list = await releases.listReleases(projectId);
      await releases.rollbackTo(projectId, list[1]!.id);

      expect(await servedHtml(second.subdomain)).toBe("<h1>version one</h1>");
    });

    it("moves the live marker", async () => {
      await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      await deployService.publish(projectId);

      const before = await releases.listReleases(projectId);
      const after = await releases.rollbackTo(projectId, before[1]!.id);

      expect(after.find((row) => row.live)?.id).toBe(before[1]?.id);
    });

    it("takes the release's own account of itself back too", async () => {
      // The deployment describes what is SERVING. Leaving the newer build's
      // size on the row would have the panel describe a build nobody serves.
      await deployService.publish(projectId);
      await write("<h1>a very much longer second version of the page</h1>");
      await deployService.publish(projectId);

      const list = await releases.listReleases(projectId);
      await releases.rollbackTo(projectId, list[1]!.id);

      const row = await prisma.deployment.findUnique({ where: { projectId } });
      expect(row?.sizeBytes).toBe(list[1]?.sizeBytes);
    });

    it("refuses a release belonging to another deployment", async () => {
      // Scoped in the WHERE clause: naming your own project must not let you
      // roll back to somebody else's build.
      await deployService.publish(projectId);

      const other = await prisma.project.create({
        data: { name: "Other", ownerId, template: "static-html" },
      });
      await mkdir(projectRoot(other.id), { recursive: true });
      await writeFile(
        path.join(projectRoot(other.id), "index.html"),
        "<h1>theirs</h1>",
      );
      await deployService.publish(other.id);
      const theirs = await releases.listReleases(other.id);

      await expect(
        releases.rollbackTo(projectId, theirs[0]!.id),
      ).rejects.toMatchObject({ code: "NO_SUCH_RELEASE" });

      await deployService.unpublish(other.id).catch(() => undefined);
    });

    it("refuses to roll back to what is already serving", async () => {
      await deployService.publish(projectId);
      const [live] = await releases.listReleases(projectId);

      await expect(
        releases.rollbackTo(projectId, live!.id),
      ).rejects.toMatchObject({ code: "ALREADY_LIVE" });
    });

    it("refuses on a project with no deployment", async () => {
      const bare = await prisma.project.create({
        data: { name: "Bare", ownerId, template: "static-html" },
      });

      await expect(
        releases.rollbackTo(bare.id, "00000000-0000-4000-8000-000000000000"),
      ).rejects.toMatchObject({ code: "NOT_DEPLOYED" });
    });
  });

  describe("taking the site down", () => {
    it("removes the history and its files", async () => {
      await deployService.publish(projectId);
      await write("<h1>version two</h1>");
      await deployService.publish(projectId);

      await deployService.unpublish(projectId);

      expect(await releases.listReleases(projectId)).toEqual([]);
      expect(
        await prisma.deploymentRelease.count({
          where: { subdomain: { not: "" }, deployment: { projectId } },
        }),
      ).toBe(0);
    });
  });
});
