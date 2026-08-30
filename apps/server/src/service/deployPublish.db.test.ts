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

  /** Where this subdomain is actually served from.
   *
   *  Asked of `resolveSite` rather than computed, because since releases
   *  shipped the answer is a pointer: each build keeps its own directory and
   *  the deployment names the live one. A test that recomputed the path would
   *  be asserting on where files used to go.
   */
  const servedRoot = async (subdomain: string) => {
    const site = await deployService.resolveSite(`${subdomain}.localhost`);
    if (!site) throw new Error(`${subdomain} is not being served`);
    return site.root;
  };

  it("copies the output to an address of its own and reports it live", async () => {
    const deployment = await deployService.publish(projectId);

    expect(deployment.status).toBe("live");
    expect(deployment.url).toContain(deployment.subdomain);
    expect(deployment.sizeBytes).toBeGreaterThan(0);

    const served = await readFile(
      path.join(await servedRoot(deployment.subdomain), "index.html"),
      "utf8",
    );
    expect(served).toBe("<h1>version one</h1>");
  });

  it("copies the whole tree, not only the index", async () => {
    const deployment = await deployService.publish(projectId);

    const asset = path.join(
      await servedRoot(deployment.subdomain),
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
    const root = await servedRoot(second.subdomain);

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

  it("offers an always-on container to a template that needs a running process", async () => {
    // This used to assert a refusal, and the refusal was the gap: six of the
    // thirteen templates could not be published at all, so half of them
    // stopped working at the point somebody wanted to show their work.
    //
    // Only the TARGET is checked here. Actually publishing one starts a
    // container and installs its dependencies, which belongs in
    // `serviceDeploy.e2e.test.ts` behind DEPLOY_E2E=1 rather than in a suite
    // that only needs a database.
    const api = await prisma.project.create({
      data: { name: "api", template: "node-express", ownerId: userId },
    });

    const state = await deployService.deploymentState(api.id);

    expect(state.target.deployable).toBe(true);
    expect(state.target.kind).toBe("service");
    expect(state.target.port).toBe(3000);
    // Nothing is read back afterwards: the command does not terminate.
    expect(state.target.outputDir).toBe("");
  });

  it("takes the site down, files and all", async () => {
    const deployment = await deployService.publish(projectId);
    const root = await servedRoot(deployment.subdomain);

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
