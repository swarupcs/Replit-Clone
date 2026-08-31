import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Forking somebody else's public project.
 *
 *  Against real rows and real files, because the two things worth proving here
 *  are both about what does NOT travel, and neither is visible from a stub:
 *  the original's environment variables, and its git directory. A fork that
 *  quietly carried either would be handing out credentials on a button press,
 *  into a project the original owner cannot see, cannot audit and cannot
 *  delete.
 *
 *  Set TEST_DATABASE_URL to a throwaway Postgres with the migrations applied.
 */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("forking a public project", () => {
  const scope = dbScope("fork-project");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let projectService: typeof import("./projectService.js");
  let accessService: typeof import("./projectAccessService.js");

  let ownerId: string;
  let strangerId: string;
  /** `setCollaborator` invites by address, not by id. */
  let strangerEmail: string;
  let sourceId: string;

  /** Everything this test created, removed however it ends. */
  const madeProjects: string[] = [];

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    projectService = await import("./projectService.js");
    accessService = await import("./projectAccessService.js");
  });

  beforeEach(async () => {
    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    strangerEmail = scope.email("stranger");
    const stranger = await prisma.user.create({
      data: { email: strangerEmail, passwordHash: "x" },
    });
    ownerId = owner.id;
    strangerId = stranger.id;

    const source = await prisma.project.create({
      data: {
        name: "Original",
        ownerId,
        template: "react-vite",
        startCommand: "npm run dev -- --host",
        // The thing that must not travel.
        envVars: { STRIPE_KEY: "sk_live_hunter2" },
      },
    });
    sourceId = source.id;
    madeProjects.push(sourceId);

    // A working tree with one ordinary file and one that must be left behind.
    const root = projectService.projectDir(sourceId);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "left"), { recursive: true });
    await writeFile(path.join(root, "src", "app.js"), "console.log('mine')");
    await writeFile(
      path.join(root, ".git", "config"),
      '[remote "origin"]\n\turl = https://x-access-token:ghp_secrettoken@github.com/a/b.git\n',
    );
    await writeFile(path.join(root, "node_modules", "left", "i.js"), "//");
  });

  afterEach(async () => {
    for (const id of madeProjects.splice(0)) {
      await rm(projectService.projectDir(id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    await scope.cleanup(prisma);
  });

  async function publish() {
    await accessService.setProjectVisibility(
      sourceId,
      ownerId,
      accessService.ProjectVisibility.PUBLIC,
    );
  }

  async function forkAsStranger() {
    const fork = await projectService.forkProjectService(sourceId, strangerId);
    madeProjects.push(fork.id);
    return fork;
  }

  describe("duplicating, which is the other way a copy is made", () => {
    /** Duplicating keeps the variables and forking does not, on the grounds
     *  that a duplicate is your own copy of your own project. But duplicating
     *  is open to a VIEWER, and reading `/env` is not — it needs editor
     *  access, because "read-only access to a project is not access to its
     *  credentials". A viewer who could duplicate with the variables attached
     *  would be reading, through a project they now own, exactly what that
     *  endpoint refuses them. */
    it("does not hand a viewer the variables it refuses to show them", async () => {
      await accessService.setCollaborator(sourceId, ownerId, strangerEmail, "VIEWER");

      const copy = await projectService.duplicateProjectService(
        sourceId,
        strangerId,
      );
      madeProjects.push(copy.id);

      expect(copy.envVars).toEqual({});
      expect(JSON.stringify(copy.envVars)).not.toContain("hunter2");
    });

    it("still carries them for an editor, who can already read them", async () => {
      // The convenience the rule is meant to preserve: a copy that cannot run
      // is not much of a copy, for somebody entitled to the credentials.
      await accessService.setCollaborator(sourceId, ownerId, strangerEmail, "EDITOR");

      const copy = await projectService.duplicateProjectService(
        sourceId,
        strangerId,
      );
      madeProjects.push(copy.id);

      expect(copy.envVars).toEqual({ STRIPE_KEY: "sk_live_hunter2" });
    });

    it("carries them for the owner", async () => {
      const copy = await projectService.duplicateProjectService(
        sourceId,
        ownerId,
      );
      madeProjects.push(copy.id);

      expect(copy.envVars).toEqual({ STRIPE_KEY: "sk_live_hunter2" });
    });
  });

  it("refuses a stranger while the project is private", async () => {
    // Reported as missing rather than forbidden, so the endpoint cannot be
    // used to find out which project ids exist.
    await expect(
      projectService.forkProjectService(sourceId, strangerId),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a stranger fork it once it is public, with no invitation", async () => {
    // The mechanic itself. Needing to be invited first is exactly what stops a
    // gallery or a shared tutorial link working at all.
    await publish();

    const fork = await forkAsStranger();

    expect(fork.ownerId).toBe(strangerId);
    expect(fork.template).toBe("react-vite");
  });

  it("does NOT carry the original's environment variables", async () => {
    // The line between a fork and a credential leak. A duplicate keeps them
    // because the project was already yours; a fork is somebody else's work.
    await publish();

    const fork = await forkAsStranger();

    expect(fork.envVars).toEqual({});
    expect(JSON.stringify(fork.envVars)).not.toContain("hunter2");
  });

  it("does not leave the secret readable through the fork's own env endpoint", async () => {
    // The row is one route to it; `getEnvVars` is the other, and it merges in
    // a managed database URL. Checked through the service the container and
    // the API both use, rather than only the column.
    await publish();
    const fork = await forkAsStranger();

    const { getEnvVars } = await import("./projectEnvService.js");

    expect(JSON.stringify(await getEnvVars(fork.id))).not.toContain("hunter2");
  });

  it("does not carry .git, so no remote URL and no token in one", async () => {
    // A remote can be `https://x-access-token:<token>@github.com/...`. Copying
    // .git into a stranger's project would hand over push access to the
    // original's repository.
    await publish();

    const fork = await forkAsStranger();
    const gitDir = path.join(projectService.projectDir(fork.id), ".git");

    await expect(stat(gitDir)).rejects.toThrow();
  });

  it("copies the actual source files", async () => {
    await publish();

    const fork = await forkAsStranger();
    const copied = await readFile(
      path.join(projectService.projectDir(fork.id), "src", "app.js"),
      "utf8",
    );

    expect(copied).toBe("console.log('mine')");
  });

  it("leaves dependencies behind, which are reproducible", async () => {
    await publish();

    const fork = await forkAsStranger();
    const modules = path.join(projectService.projectDir(fork.id), "node_modules");

    await expect(stat(modules)).rejects.toThrow();
  });

  it("starts private, whatever the original was", async () => {
    // Publishing is a decision. Pressing Fork is not the same decision, and
    // inheriting PUBLIC would make it one on the forker's behalf.
    await publish();

    const fork = await forkAsStranger();

    expect(fork.visibility).toBe("PRIVATE");
  });

  it("records where it came from", async () => {
    await publish();

    const fork = await forkAsStranger();

    expect(fork.forkedFromId).toBe(sourceId);
  });

  it("keeps the fork when the original is deleted", async () => {
    // Provenance, not ownership. SetNull rather than Cascade, or deleting an
    // original would delete work somebody else now owns.
    await publish();
    const fork = await forkAsStranger();

    await prisma.project.delete({ where: { id: sourceId } });

    const after = await prisma.project.findUnique({ where: { id: fork.id } });
    expect(after).not.toBeNull();
    expect(after?.forkedFromId).toBeNull();
  });

  it("carries the start command, which is how the project runs", async () => {
    await publish();

    const fork = await forkAsStranger();

    expect(fork.startCommand).toBe("npm run dev -- --host");
  });

  it("gives the forker no access to the original beyond visitor", async () => {
    // Forking is not a way in. The copy is theirs; the original is not.
    await publish();
    await forkAsStranger();

    const access = await accessService.getProjectAccess(sourceId, strangerId);
    expect(access?.level).toBe("visitor");
  });
});
