import { beforeEach, describe, expect, it, vi } from "vitest";

/** A delete that can be undone.
 *
 *  `deleteProjectService` removed the container, the managed database AND its
 *  volume, the checkpoints, the cache volume, the published files, the row and
 *  the working tree — correctly, thoroughly, irreversibly, with a confirmation
 *  dialog as the only thing in front of it.
 *
 *  The split these tests pin down is the whole design: everything that costs
 *  money or serves the public stops NOW, and everything that is the user's
 *  data is held. Getting it backwards in either direction is a real failure —
 *  a deleted project still serving its site for a week, or a trash that gives
 *  nothing back because the volume went with the row.
 */

const projectUpdate = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const projectDelete = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      update: projectUpdate,
      findUnique: projectFindUnique,
      findMany: projectFindMany,
      delete: projectDelete,
    },
  },
}));

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("./projectAccessService.js", () => ({
  assertProjectAccess,
  getProjectAccess: vi.fn(),
}));

const removeContainer = vi.hoisted(() => vi.fn());
const removeCacheVolume = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({
  removeContainer,
  removeCacheVolume,
}));

const stopDatabase = vi.hoisted(() => vi.fn());
const destroyDatabase = vi.hoisted(() => vi.fn());
vi.mock("./managedDatabaseService.js", () => ({
  stop: stopDatabase,
  destroy: destroyDatabase,
  provision: vi.fn(),
}));

const unpublish = vi.hoisted(() => vi.fn());
vi.mock("./deployService.js", () => ({ unpublish }));

const revokeEmbed = vi.hoisted(() => vi.fn());
vi.mock("./embedService.js", () => ({ revokeEmbed }));

const assertCanCreateProject = vi.hoisted(() => vi.fn());
vi.mock("./userQuotaService.js", () => ({
  assertCanCreateProject,
  forgetUserQuota: vi.fn(),
}));

// These are awaited with `.catch()` in the purge, so they have to be promises
// rather than bare spies: a mock that returns undefined fails on `.catch` and
// looks exactly like the code under test being wrong.
vi.mock("./checkpointService.js", () => ({
  forgetProject: vi.fn(() => Promise.resolve()),
}));
vi.mock("./collabService.js", () => ({ forgetProject: vi.fn() }));
vi.mock("./diskUsageService.js", () => ({ forgetUsage: vi.fn() }));
vi.mock("../containers/runner.js", () => ({ forgetRun: vi.fn() }));
vi.mock("../containers/devcontainer.js", () => ({ forgetDevcontainer: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const rm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ default: { rm, mkdir: vi.fn(), cp: vi.fn() } }));

import {
  listTrashedProjects,
  purgeExpiredTrash,
  purgeProjectService,
  restoreProjectService,
  trashProjectService,
  TRASH_DAYS,
} from "./projectService.js";
import { NotFoundError } from "../utils/errors.js";

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const SECOND = "8f2e5c13-4b6a-4d92-9e07-1a3c6b8d5f42";

beforeEach(() => {
  vi.clearAllMocks();
  assertProjectAccess.mockResolvedValue({ id: PROJECT, ownerId: OWNER });
  projectUpdate.mockResolvedValue({ id: PROJECT, deletedAt: null });
  projectFindMany.mockResolvedValue([]);
  assertCanCreateProject.mockResolvedValue(undefined);
  unpublish.mockResolvedValue(undefined);
  revokeEmbed.mockResolvedValue(undefined);
  stopDatabase.mockResolvedValue(undefined);
  destroyDatabase.mockResolvedValue(undefined);
  removeContainer.mockResolvedValue(undefined);
  removeCacheVolume.mockResolvedValue(undefined);
  projectDelete.mockResolvedValue(undefined);
  rm.mockResolvedValue(undefined);
});

describe("deleting a project", () => {
  it("is still the owner's alone", async () => {
    await trashProjectService(PROJECT, OWNER);

    expect(assertProjectAccess).toHaveBeenCalledWith(PROJECT, OWNER, "owner");
  });

  it("keeps the row and the working tree", async () => {
    await trashProjectService(PROJECT, OWNER);

    // The entire point. Either of these would make restore a lie.
    expect(projectDelete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it("marks it deleted rather than deleting it", async () => {
    await trashProjectService(PROJECT, OWNER);

    const data = (projectUpdate.mock.calls[0]?.[0] as { data: { deletedAt: Date } }).data;
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it("stops everything that costs money", async () => {
    await trashProjectService(PROJECT, OWNER);

    expect(removeContainer).toHaveBeenCalledWith(PROJECT);
    expect(stopDatabase).toHaveBeenCalledWith(PROJECT);
  });

  /** A deleted project that went on serving its site, or handing out its
   *  source through an embed token, for a week is indefensible. */
  it("takes down every public surface at once", async () => {
    await trashProjectService(PROJECT, OWNER);

    expect(unpublish).toHaveBeenCalledWith(PROJECT);
    expect(revokeEmbed).toHaveBeenCalledWith(PROJECT);

    const data = (projectUpdate.mock.calls[0]?.[0] as { data: { shareToken: null } }).data;
    expect(data.shareToken).toBeNull();
  });

  /** The volume is the user's data, and a trash that throws the data away
   *  gives back an empty project. `destroy` belongs to the purge. */
  it("stops the managed database without destroying its volume", async () => {
    await trashProjectService(PROJECT, OWNER);

    expect(destroyDatabase).not.toHaveBeenCalled();
  });

  /** Docker being unreachable must not leave a project half-deleted: the
   *  column is what every guard reads, so it has to be written anyway. */
  it("still marks it deleted when the teardown fails", async () => {
    unpublish.mockRejectedValue(new Error("docker is down"));
    stopDatabase.mockRejectedValue(new Error("docker is down"));
    revokeEmbed.mockRejectedValue(new Error("nope"));

    await trashProjectService(PROJECT, OWNER);

    expect(projectUpdate).toHaveBeenCalled();
  });
});

describe("taking it back", () => {
  it("clears the column and keeps the id", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: new Date() });
    projectUpdate.mockResolvedValue({ id: PROJECT, deletedAt: null });

    const restored = await restoreProjectService(PROJECT, OWNER);

    expect(restored.id).toBe(PROJECT);
    expect(projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT },
      data: { deletedAt: null },
    });
  });

  /** To anybody but the owner this id is simply gone, and saying anything
   *  else would make the trash a way to discover which ids exist. */
  it("is not somebody else's to do", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: new Date() });

    await expect(restoreProjectService(PROJECT, STRANGER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it("refuses a project that was never in the trash", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: null });

    await expect(restoreProjectService(PROJECT, OWNER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  /** Room has to exist first. Trashing stops the project counting against the
   *  quota, so restoring can walk past the limit — the same hole as a trash
   *  that keeps counting, in the other direction. */
  it("will not restore past the project limit", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: new Date() });
    assertCanCreateProject.mockRejectedValue(new Error("PROJECT_LIMIT"));

    await expect(restoreProjectService(PROJECT, OWNER)).rejects.toThrow();
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  /** The site, the embed and the share link were surfaces the owner gave up.
   *  Handing them back unasked would be the platform deciding who may read
   *  something on the owner's behalf. */
  it("does not republish or re-share anything", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: new Date() });

    await restoreProjectService(PROJECT, OWNER);

    const data = (projectUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> })
      .data;
    expect(Object.keys(data)).toEqual(["deletedAt"]);
  });
});

describe("emptying the trash by hand", () => {
  it("deletes for real", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: new Date() });

    await purgeProjectService(PROJECT, OWNER);

    expect(projectDelete).toHaveBeenCalledWith({ where: { id: PROJECT } });
    expect(rm).toHaveBeenCalled();
    // And now the volume goes, which is what makes this the irreversible one.
    expect(destroyDatabase).toHaveBeenCalledWith(PROJECT);
  });

  /** Otherwise the one-button irreversible delete is back, wearing a
   *  different route. */
  it("refuses a project that is not in the trash", async () => {
    projectFindUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: null });

    await expect(purgeProjectService(PROJECT, OWNER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(projectDelete).not.toHaveBeenCalled();
  });
});

describe("the sweep", () => {
  it("takes only what is past the grace period", async () => {
    const now = new Date("2026-09-10T00:00:00.000Z");

    await purgeExpiredTrash(now);

    const where = (projectFindMany.mock.calls[0]?.[0] as {
      where: { deletedAt: { lt: Date } };
    }).where;
    const days = (now.getTime() - where.deletedAt.lt.getTime()) / 86_400_000;
    expect(days).toBe(TRASH_DAYS);
  });

  /** One tree that will not delete must not stop the sweep, or a single stuck
   *  project keeps every other account's disk occupied indefinitely. */
  it("carries on past a project it cannot delete", async () => {
    // Real ids: `projectDir` validates, so "a" and "b" fail before the delete
    // does and both projects look stuck for the wrong reason.
    projectFindMany.mockResolvedValue([
      { id: PROJECT, ownerId: OWNER },
      { id: SECOND, ownerId: OWNER },
    ]);
    projectDelete.mockRejectedValueOnce(new Error("in use"));

    expect(await purgeExpiredTrash()).toBe(1);
    expect(projectDelete).toHaveBeenCalledTimes(2);
  });
});

describe("what the trash holds", () => {
  it("is this owner's, and only the deleted ones", async () => {
    await listTrashedProjects(OWNER);

    expect(projectFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: OWNER, deletedAt: { not: null } },
      }),
    );
  });
});
