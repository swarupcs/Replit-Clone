import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Publishing, against real rows and a real directory.
 *
 *  The Static HTML template is used deliberately: it has no build command, so
 *  this exercises everything around the build — reserving the address, checking
 *  what the output actually contains, copying it out, swapping it into place,
 *  and taking it down again — without needing a Docker daemon. The build exec
 *  itself is the one link this cannot reach, and it is a single `execCapture`
 *  call covered by its own tests.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("publishing a project", () => {
  const scope = dbScope("deploy-publish");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let deployService: typeof import("./deployService.js");
  let projectRoot: (id: string) => string;

  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    deployService = await import("./deployService.js");
    ({ projectRoot } = await import("../utils/projectPaths.js"));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      // Static HTML: the template that IS its own output.
      data: { name: "site", template: "static-html", ownerId: userId },
    });
    projectId = project.id;

    const root = projectRoot(projectId);
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>version one</h1>");
    await writeFile(path.join(root, "assets", "style.css"), "body{}");
  });

  afterEach(async () => {
    // Before the rows go, so the files go with them.
    await deployService.unpublish(projectId).catch(() => undefined);
    await scope.cleanup(prisma);
    await rm(projectRoot(projectId), { recursive: true, force: true });
  });

  it("copies the output to an address of its own and reports it live", async () => {
    const deployment = await deployService.publish(projectId);

    expect(deployment.status).toBe("live");
    expect(deployment.url).toContain(deployment.subdomain);
    expect(deployment.sizeBytes).toBeGreaterThan(0);

    const served = await readFile(
      path.join(deployService.siteDirectory(deployment.subdomain), "index.html"),
      "utf8",
    );
    expect(served).toBe("<h1>version one</h1>");
  });

  it("copies the whole tree, not only the index", async () => {
    const deployment = await deployService.publish(projectId);

    const asset = path.join(
      deployService.siteDirectory(deployment.subdomain),
      "assets",
      "style.css",
    );
    expect((await stat(asset)).isFile()).toBe(true);
  });

  it("keeps the address across a redeploy", async () => {
    // A link already handed out is the entire point of having published one.
    const first = await deployService.publish(projectId);

    await writeFile(
      path.join(projectRoot(projectId), "index.html"),
      "<h1>version two</h1>",
    );
    const second = await deployService.publish(projectId);

    expect(second.subdomain).toBe(first.subdomain);
    expect(second.url).toBe(first.url);
  });

  it("replaces the published files rather than merging into them", async () => {
    await deployService.publish(projectId);

    // A file that exists in the first build and not the second.
    await rm(path.join(projectRoot(projectId), "assets", "style.css"));
    await writeFile(
      path.join(projectRoot(projectId), "index.html"),
      "<h1>version two</h1>",
    );

    const second = await deployService.publish(projectId);
    const root = deployService.siteDirectory(second.subdomain);

    expect(await readFile(path.join(root, "index.html"), "utf8")).toBe(
      "<h1>version two</h1>",
    );
    // Left behind, a stale asset from a previous build is served forever.
    await expect(stat(path.join(root, "assets", "style.css"))).rejects.toThrow();
  });

  it("refuses an output with no home page, and says so", async () => {
    // A visitor's one URL landing on a 404 is a worse outcome than being told
    // now, while there is something to do about it.
    await rm(path.join(projectRoot(projectId), "index.html"));

    await expect(deployService.publish(projectId)).rejects.toThrow(/index\.html/);
  });

  it("records the failure on the row rather than only throwing", async () => {
    await rm(path.join(projectRoot(projectId), "index.html"));

    await deployService.publish(projectId).catch(() => undefined);

    const row = await prisma.deployment.findUnique({ where: { projectId } });
    expect(row?.status).toBe("FAILED");
    expect(row?.error).toContain("index.html");
  });

  it("does not claim a failed build went live", async () => {
    await rm(path.join(projectRoot(projectId), "index.html"));

    await deployService.publish(projectId).catch(() => undefined);

    const state = await deployService.deploymentState(projectId);
    expect(state.deployment?.status).toBe("failed");
    expect(state.deployment?.url).toBeNull();
  });

  it("refuses a project whose template needs a running process", async () => {
    const api = await prisma.project.create({
      data: { name: "api", template: "node-express", ownerId: userId },
    });

    await expect(deployService.publish(api.id)).rejects.toThrow(
      /running process/i,
    );
  });

  it("takes the site down, files and all", async () => {
    const deployment = await deployService.publish(projectId);
    const root = deployService.siteDirectory(deployment.subdomain);

    await deployService.unpublish(projectId);

    await expect(stat(root)).rejects.toThrow();
    expect(
      await prisma.deployment.findUnique({ where: { projectId } }),
    ).toBeNull();
  });

  it("treats unpublishing something already gone as done, not as an error", async () => {
    await expect(deployService.unpublish(projectId)).resolves.toBeUndefined();
  });

  it("reports what a project could be published as before it ever is", async () => {
    const state = await deployService.deploymentState(projectId);

    expect(state.deployment).toBeNull();
    expect(state.target.deployable).toBe(true);
    expect(state.target.outputDir).toBe(".");
  });
});
