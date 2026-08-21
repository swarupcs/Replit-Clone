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

  const allows = async (userId: string, need: "viewer" | "editor" | "owner") => {
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
});
