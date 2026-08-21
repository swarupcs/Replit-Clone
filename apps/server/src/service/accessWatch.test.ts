import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbScope } from "../test/dbScope.js";

/** Needs real rows: the whole point is that the answer can change under a
 *  connection that is already open. */
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("accessWatch", () => {
  const scope = dbScope("access-watch");

  let prisma: typeof import("../lib/prisma.js").prisma;
  let watch: typeof import("./accessWatch.js");
  let ownerId: string;
  let collaboratorId: string;
  let projectId: string;

  beforeEach(async () => {
    process.env["DATABASE_URL"] = TEST_DATABASE_URL;

    ({ prisma } = await import("../lib/prisma.js"));
    watch = await import("./accessWatch.js");
    watch.resetAccessWatch();

    const owner = await prisma.user.create({
      data: { email: scope.email("owner"), passwordHash: "x" },
    });
    const collaborator = await prisma.user.create({
      data: { email: scope.email("mate"), passwordHash: "x" },
    });
    ownerId = owner.id;
    collaboratorId = collaborator.id;

    const project = await prisma.project.create({
      data: { name: "p", ownerId, template: "react-vite" },
    });
    projectId = project.id;

    await prisma.projectCollaborator.create({
      data: { projectId, userId: collaboratorId, role: "EDITOR" },
    });
  });

  afterEach(async () => {
    watch.resetAccessWatch();
    // Only this suite's rows. Truncating shared tables deletes what another
    // suite running in parallel has just inserted.
    await scope.cleanup(prisma);
  });

  it("says nothing while access is unchanged", async () => {
    const onRevoked = vi.fn();
    const onChanged = vi.fn();

    watch.watchAccess("s1", {
      userId: collaboratorId,
      projectId,
      level: "editor",
      onRevoked,
      onChanged,
    });

    await watch.sweepAccess();

    expect(onRevoked).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("closes a connection whose collaborator was removed", async () => {
    const onRevoked = vi.fn();

    watch.watchAccess("s1", {
      userId: collaboratorId,
      projectId,
      level: "editor",
      onRevoked,
      onChanged: vi.fn(),
    });

    await prisma.projectCollaborator.deleteMany({ where: { projectId } });
    await watch.sweepAccess();

    expect(onRevoked).toHaveBeenCalledOnce();
  });

  it("reports a demotion instead of closing the connection", async () => {
    const onRevoked = vi.fn();
    const onChanged = vi.fn();

    watch.watchAccess("s1", {
      userId: collaboratorId,
      projectId,
      level: "editor",
      onRevoked,
      onChanged,
    });

    await prisma.projectCollaborator.update({
      where: { projectId_userId: { projectId, userId: collaboratorId } },
      data: { role: "VIEWER" },
    });
    await watch.sweepAccess();

    expect(onChanged).toHaveBeenCalledWith("viewer");
    // Read-only access is still access; they keep the page.
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("reports a demotion once, not on every sweep", async () => {
    const onChanged = vi.fn();

    watch.watchAccess("s1", {
      userId: collaboratorId,
      projectId,
      level: "editor",
      onRevoked: vi.fn(),
      onChanged,
    });

    await prisma.projectCollaborator.update({
      where: { projectId_userId: { projectId, userId: collaboratorId } },
      data: { role: "VIEWER" },
    });

    await watch.sweepAccess();
    await watch.sweepAccess();
    await watch.sweepAccess();

    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("stops watching once the connection is released", async () => {
    const onRevoked = vi.fn();

    const release = watch.watchAccess("s1", {
      userId: collaboratorId,
      projectId,
      level: "editor",
      onRevoked,
      onChanged: vi.fn(),
    });

    release();
    await prisma.projectCollaborator.deleteMany({ where: { projectId } });
    await watch.sweepAccess();

    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("closes connections to a project that no longer exists", async () => {
    const onRevoked = vi.fn();

    watch.watchAccess("s1", {
      userId: ownerId,
      projectId,
      level: "owner",
      onRevoked,
      onChanged: vi.fn(),
    });

    await prisma.projectCollaborator.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await watch.sweepAccess();

    expect(onRevoked).toHaveBeenCalledOnce();
  });

  it("leaves the owner alone", async () => {
    const onRevoked = vi.fn();
    const onChanged = vi.fn();

    watch.watchAccess("s1", {
      userId: ownerId,
      projectId,
      level: "owner",
      onRevoked,
      onChanged,
    });

    await watch.sweepAccess();

    expect(onRevoked).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
