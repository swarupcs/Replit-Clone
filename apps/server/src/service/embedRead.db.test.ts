import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** What an anonymous reader can and cannot reach, against real rows and a real
 *  project directory.
 *
 *  The unit tests pin down the predicates; this pins down the thing that
 *  actually matters — that the listing and the file endpoint agree. A path
 *  hidden from the listing but readable by asking for it directly is not
 *  hidden, and only a test that asks for it directly can tell.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("reading a project through an embed", () => {
  const scope = dbScope("embed-read");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let embedService: typeof import("./embedService.js");
  let projectRoot: (id: string) => string;

  let userId: string;
  let projectId: string;
  let token: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    embedService = await import("./embedService.js");
    ({ projectRoot } = await import("../utils/projectPaths.js"));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { name: "demo", template: "static-html", ownerId: userId },
    });
    projectId = project.id;

    const root = projectRoot(projectId);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<h1>hello</h1>");
    await writeFile(path.join(root, "src", "app.js"), "console.log(1)");
    // The file the whole hidden-paths rule exists for.
    await writeFile(path.join(root, ".env"), "STRIPE_SECRET=sk_live_real");

    const state = await embedService.createEmbed(projectId);
    token = state.token ?? "";
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
    await rm(projectRoot(projectId), { recursive: true, force: true });
  });

  it("lists the project's files and serves one of them", async () => {
    const payload = await embedService.embedPayload(token);

    expect(payload.projectName).toBe("demo");
    expect(payload.files.map((f) => f.relPath).sort()).toEqual([
      "index.html",
      "src/app.js",
    ]);

    const file = await embedService.embedFile(token, "src/app.js");
    expect(file.contents).toBe("console.log(1)");
    expect(file.truncated).toBe(false);
  });

  it("never lists .env, and refuses it when asked for by name", async () => {
    const payload = await embedService.embedPayload(token);
    expect(payload.files.some((f) => f.relPath === ".env")).toBe(false);

    // The half that matters. Omitting it from the listing is presentation;
    // refusing it here is the actual control.
    await expect(embedService.embedFile(token, ".env")).rejects.toThrow(
      /no such file/i,
    );
  });

  it("refuses a path that tries to leave the project", async () => {
    for (const bad of [
      "../../../etc/passwd",
      "..",
      "src/../../.env",
      "/etc/passwd",
      "src\\app.js",
    ]) {
      await expect(embedService.embedFile(token, bad), bad).rejects.toThrow();
    }
  });

  it("tells a revoked token apart from nothing at all -- and does not", async () => {
    await embedService.revokeEmbed(projectId);

    const revoked = await embedService
      .embedPayload(token)
      .then(() => null)
      .catch((error: Error) => error.message);

    const neverExisted = await embedService
      .embedPayload("z".repeat(43))
      .then(() => null)
      .catch((error: Error) => error.message);

    // Identical on purpose. A public endpoint that distinguishes them is an
    // oracle for which tokens exist.
    expect(revoked).toBe(neverExisted);
    expect(revoked).toMatch(/not available/i);
  });

  it("rotates the token on create, so the old snippet stops working", async () => {
    const replaced = await embedService.createEmbed(projectId);

    expect(replaced.token).not.toBe(token);
    await expect(embedService.embedPayload(token)).rejects.toThrow();
    await expect(
      embedService.embedPayload(replaced.token ?? ""),
    ).resolves.toBeTruthy();
  });

  it("keeps the token when only the settings change", async () => {
    // The reason update exists separately: an owner adjusting which file opens
    // first must not break every page that already carries the snippet.
    const updated = await embedService.updateEmbed(projectId, { view: "code" });

    expect(updated.token).toBe(token);
    expect(updated.settings.view).toBe("code");
    expect((await embedService.embedPayload(token)).view).toBe("code");
  });

  it("refuses to make a secret file the one that opens first", async () => {
    await expect(
      embedService.updateEmbed(projectId, { activeFile: ".env" }),
    ).rejects.toThrow();
  });

  it("falls back when the chosen file is gone", async () => {
    await embedService.updateEmbed(projectId, { activeFile: "src/app.js" });
    await rm(path.join(projectRoot(projectId), "src", "app.js"));

    // An embed opening on an empty pane is a worse answer than one opening on
    // a different file.
    const payload = await embedService.embedPayload(token);
    expect(payload.activeFile).toBe("index.html");
  });

  it("names the hidden files for the owner", async () => {
    const state = await embedService.embedState(projectId);
    expect(state.hiddenPaths).toEqual([".env"]);
  });

  it("has no preview until the project is actually deployed", async () => {
    expect((await embedService.embedPayload(token)).previewUrl).toBeNull();
    expect((await embedService.embedState(projectId)).hasDeployment).toBe(false);
  });
});
