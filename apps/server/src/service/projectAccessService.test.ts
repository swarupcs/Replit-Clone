import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Access control decides who can read and write other people's work, so it is
 *  exercised against real rows rather than a stub. Set TEST_DATABASE_URL to a
 *  throwaway Postgres with the migrations applied; CI always does. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("project access", () => {
  const scope = dbScope("project-access");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let service: typeof import("./projectAccessService.js");

  let ownerId: string;
  let mateId: string;
  let strangerId: string;
  let projectId: string;

  beforeAll(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;
    ({ prisma } = await import("../lib/prisma.js"));
    service = await import("./projectAccessService.js");
  });

  beforeEach(async () => {
    // Scoped, never truncated: these files run in parallel and truncating
    // shared tables deletes rows another suite has just inserted.
    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    const mate = await prisma.user.create({
      data: { email: scope.email("mate"), passwordHash: "x" },
    });
    const stranger = await prisma.user.create({
      data: { email: scope.email("stranger"), passwordHash: "x" },
    });
    const project = await prisma.project.create({
      data: { name: "P", ownerId: owner.id, template: "react-vite" },
    });

    ownerId = owner.id;
    mateId = mate.id;
    strangerId = stranger.id;
    projectId = project.id;
  });

  afterEach(async () => {
    await scope.cleanup(prisma);
  });

  const level = async (userId: string) =>
    (await service.getProjectAccess(projectId, userId))?.level;

  const allows = async (
    userId: string,
    need: "visitor" | "viewer" | "editor" | "owner",
  ) => {
    try {
      await service.assertProjectAccess(projectId, userId, need);
      return true;
    } catch {
      return false;
    }
  };

  const emailOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;

  it("gives the owner every level", async () => {
    expect(await level(ownerId)).toBe("owner");
    expect(await allows(ownerId, "owner")).toBe(true);
  });

  it("gives someone unrelated nothing, and reports it as missing", async () => {
    expect(await level(strangerId)).toBe("none");
    // 404 rather than 403, so ids cannot be enumerated.
    await expect(
      service.assertProjectAccess(projectId, strangerId, "viewer"),
    ).rejects.toThrow(/not found/i);
  });

  it("lets a viewer read but not write", async () => {
    await service.setCollaborator(
      projectId,
      ownerId,
      await emailOf(mateId),
      service.ProjectRole.VIEWER,
    );

    expect(await allows(mateId, "viewer")).toBe(true);
    expect(await allows(mateId, "editor")).toBe(false);
    expect(await allows(mateId, "owner")).toBe(false);
  });

  it("lets an editor write but not act as the owner", async () => {
    await service.setCollaborator(
      projectId,
      ownerId,
      await emailOf(mateId),
      service.ProjectRole.EDITOR,
    );

    expect(await allows(mateId, "editor")).toBe(true);
    expect(await allows(mateId, "owner")).toBe(false);
  });

  it("changes a collaborator's role in place rather than duplicating them", async () => {
    const email = await emailOf(mateId);
    await service.setCollaborator(projectId, ownerId, email, service.ProjectRole.VIEWER);
    await service.setCollaborator(projectId, ownerId, email, service.ProjectRole.EDITOR);

    expect(await level(mateId)).toBe("editor");
    expect(await prisma.projectCollaborator.count({ where: { projectId } })).toBe(1);
  });

  it("only lets the owner manage access", async () => {
    await expect(
      service.setCollaborator(
        projectId,
        strangerId,
        await emailOf(strangerId),
        service.ProjectRole.EDITOR,
      ),
    ).rejects.toThrow();
  });

  it("refuses to add the owner as their own collaborator", async () => {
    await expect(
      service.setCollaborator(
        projectId,
        ownerId,
        await emailOf(ownerId),
        service.ProjectRole.VIEWER,
      ),
    ).rejects.toThrow(/owner/i);
  });

  it("refuses an email with no account", async () => {
    await expect(
      service.setCollaborator(projectId, ownerId, "nobody@nowhere.test", service.ProjectRole.VIEWER),
    ).rejects.toThrow(/no account/i);
  });

  it("lists shared projects for the collaborator and nobody else", async () => {
    await service.setCollaborator(
      projectId,
      ownerId,
      await emailOf(mateId),
      service.ProjectRole.VIEWER,
    );

    expect(await service.listAccessibleProjects(mateId)).toHaveLength(1);
    expect(await service.listAccessibleProjects(strangerId)).toHaveLength(0);
  });

  /** The list used to return whole `Project` rows, which is the hazard the
   *  comment on `listPublicProjects` names twenty lines below it. A viewer got
   *  `shareToken` -- a bearer credential that redeems at the link's role, so a
   *  read-only collaborator could hand out access the owner never offered --
   *  and the names of every environment variable, which 2.14 settled is not
   *  something read-only access carries. */
  it("does not hand a viewer the share token or the env var names", async () => {
    await service.rotateShareToken(projectId, ownerId, service.ProjectRole.VIEWER);
    await prisma.project.update({
      where: { id: projectId },
      data: { envVars: { STRIPE_SECRET_KEY: "sealed" } },
    });
    await service.setCollaborator(
      projectId,
      ownerId,
      await emailOf(mateId),
      service.ProjectRole.VIEWER,
    );

    const [listed] = await service.listAccessibleProjects(mateId);

    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("shareToken");
    expect(listed).not.toHaveProperty("envVars");
    // Still everything the dashboard actually renders.
    expect(listed).toMatchObject({ id: projectId, visibility: "PRIVATE" });
    expect(listed?.takenDownAt).toBeNull();
  });

  it("revokes access when a collaborator is removed", async () => {
    await service.setCollaborator(
      projectId,
      ownerId,
      await emailOf(mateId),
      service.ProjectRole.EDITOR,
    );
    await service.removeCollaborator(projectId, ownerId, mateId);

    expect(await level(mateId)).toBe("none");
  });

  describe("share links", () => {
    it("mints a token long enough to be unguessable", async () => {
      const token = await service.rotateShareToken(projectId, ownerId);
      // It is a bearer credential in a URL, so uniqueness is not enough.
      expect(token.length).toBeGreaterThanOrEqual(40);
    });

    it("grants the link's role when redeemed", async () => {
      const token = await service.rotateShareToken(projectId, ownerId);
      await service.redeemShareToken(token, strangerId);

      expect(await level(strangerId)).toBe("viewer");
    });

    it("does not demote someone who already has more access", async () => {
      await service.setCollaborator(
        projectId,
        ownerId,
        await emailOf(mateId),
        service.ProjectRole.EDITOR,
      );

      const token = await service.rotateShareToken(projectId, ownerId);
      await service.redeemShareToken(token, mateId);

      expect(await level(mateId)).toBe("editor");
    });

    it("invalidates every earlier link when a new one is created", async () => {
      const first = await service.rotateShareToken(projectId, ownerId);
      await service.rotateShareToken(projectId, ownerId);

      await expect(service.redeemShareToken(first, strangerId)).rejects.toThrow();
    });

    it("leaves access already granted intact after rotating", async () => {
      const first = await service.rotateShareToken(projectId, ownerId);
      await service.redeemShareToken(first, strangerId);
      await service.rotateShareToken(projectId, ownerId);

      expect(await level(strangerId)).toBe("viewer");
    });

    it("stops working once revoked", async () => {
      const token = await service.rotateShareToken(projectId, ownerId);
      await service.revokeShareToken(projectId, ownerId);

      await expect(service.redeemShareToken(token, strangerId)).rejects.toThrow();
    });

    it("only lets the owner create or revoke a link", async () => {
      await expect(service.rotateShareToken(projectId, strangerId)).rejects.toThrow();
      await expect(service.revokeShareToken(projectId, strangerId)).rejects.toThrow();
    });
  });

  describe("a public project", () => {
    async function publish() {
      await service.setProjectVisibility(
        projectId,
        ownerId,
        service.ProjectVisibility.PUBLIC,
      );
    }

    it("is invisible to a stranger until it is published", async () => {
      expect(await level(strangerId)).toBe("none");
    });

    it("gives a stranger `visitor`, and only `visitor`", async () => {
      await publish();

      expect(await level(strangerId)).toBe("visitor");
    });

    it("does NOT give a stranger the things a named viewer gets", async () => {
      // The entire security design of this feature is that `visitor` ranks
      // BELOW `viewer`. Every existing check in the codebase asks for viewer or
      // higher, so they all keep refusing a stranger with no further work --
      // and had PUBLIC granted `viewer` instead, making a project public would
      // silently have handed out the database query editor (viewer-level
      // throughout `databaseController`) and the git history, remote URLs and
      // any token in them.
      await publish();

      expect(await allows(strangerId, "visitor")).toBe(true);
      expect(await allows(strangerId, "viewer")).toBe(false);
      expect(await allows(strangerId, "editor")).toBe(false);
      expect(await allows(strangerId, "owner")).toBe(false);
    });

    it("never lets a stranger write, however public it is", async () => {
      await publish();

      await expect(
        service.assertProjectAccess(projectId, strangerId, "editor"),
      ).rejects.toThrow();
    });

    it("does not demote somebody who was actually invited", async () => {
      // An editor invited before the project was published keeps editor. The
      // public grant is a floor, not a ceiling, and the order of the checks in
      // `getProjectAccess` is what makes that true.
      await service.setCollaborator(
        projectId,
        ownerId,
        await emailOf(mateId),
        service.ProjectRole.EDITOR,
      );
      await publish();

      expect(await level(mateId)).toBe("editor");
    });

    it("leaves the owner as the owner", async () => {
      await publish();

      expect(await level(ownerId)).toBe("owner");
    });

    it("goes back to invisible when it is made private again", async () => {
      await publish();
      await service.setProjectVisibility(
        projectId,
        ownerId,
        service.ProjectVisibility.PRIVATE,
      );

      expect(await level(strangerId)).toBe("none");
    });

    it("can only be published by its owner", async () => {
      // Publishing puts somebody's source in front of strangers. A
      // collaborator with edit access has not been given that decision.
      await service.setCollaborator(
        projectId,
        ownerId,
        await emailOf(mateId),
        service.ProjectRole.EDITOR,
      );

      await expect(
        service.setProjectVisibility(
          projectId,
          mateId,
          service.ProjectVisibility.PUBLIC,
        ),
      ).rejects.toThrow();
    });

    it("does not touch the collaborator list or the share link", async () => {
      // Publishing is one decision. Revoking an invitation as a side effect of
      // it would be a second one the owner did not make.
      await service.setCollaborator(
        projectId,
        ownerId,
        await emailOf(mateId),
        service.ProjectRole.VIEWER,
      );
      const token = await service.rotateShareToken(projectId, ownerId);

      await publish();

      expect(await service.listCollaborators(projectId, ownerId)).toHaveLength(1);
      const after = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });
      expect(after.shareToken).toBe(token);
    });
  });

  describe("the gallery", () => {
    it("lists a project once it is public", async () => {
      await service.setProjectVisibility(
        projectId,
        ownerId,
        service.ProjectVisibility.PUBLIC,
      );

      const listed = await service.listPublicProjects();

      expect(listed.map((row) => row.id)).toContain(projectId);
    });

    it("does not list a private one", async () => {
      const listed = await service.listPublicProjects();

      expect(listed.map((row) => row.id)).not.toContain(projectId);
    });

    it("carries no secrets and no share token", async () => {
      // This list is readable by anybody with an account. A `Project` row
      // carries `envVars` and `shareToken`, so the shape is narrowed at the
      // query rather than trusted to be stripped by whoever renders it.
      await prisma.project.update({
        where: { id: projectId },
        data: { envVars: { API_KEY: "hunter2" }, shareToken: "s3cret-token" },
      });
      await service.setProjectVisibility(
        projectId,
        ownerId,
        service.ProjectVisibility.PUBLIC,
      );

      // Restricted to this suite's own rows. `listPublicProjects` is global,
      // as a gallery has to be, so serialising the whole list here would make
      // the assertion depend on what every other suite happens to have
      // published at that moment.
      const listed = (await service.listPublicProjects()).filter(
        (row) => row.id === projectId,
      );
      const serialised = JSON.stringify(listed);

      expect(listed).toHaveLength(1);

      expect(serialised).not.toContain("hunter2");
      expect(serialised).not.toContain("s3cret-token");
      expect(serialised).not.toContain("envVars");
    });

    it("names the owner without publishing their email address", async () => {
      await service.setProjectVisibility(
        projectId,
        ownerId,
        service.ProjectVisibility.PUBLIC,
      );

      const listed = await service.listPublicProjects();
      const mine = listed.find((row) => row.id === projectId);

      expect(mine?.ownerName).not.toContain("@");
      expect(JSON.stringify(listed)).not.toContain(await emailOf(ownerId));
    });
  });
});
