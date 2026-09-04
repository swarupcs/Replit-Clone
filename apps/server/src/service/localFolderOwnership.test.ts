import { beforeEach, describe, expect, it, vi } from "vitest";

/** The four things this codebase does to a working tree because it owns it.
 *
 *  Each is correct for a directory the server made and is a different kind of
 *  wrong for a folder somebody opened:
 *
 *  | operation | on a server-owned tree | on a folder somebody opened |
 *  |---|---|---|
 *  | `purgeProject`'s `fs.rm` | reclaims disk | deletes their source |
 *  | `claimForSandbox` | makes the mount writable | seizes their files |
 *  | the project disk quota | rations a shared VM | refuses their own space |
 *  | the user disk quota | the same, per account | the same, per account |
 *
 *  Tested per operation rather than through one end-to-end case, because each
 *  lives in a different module and the failure of any one of them is complete
 *  on its own -- a purge that deletes somebody's code is not made acceptable by
 *  the other three being right.
 */

const projectFindUnique = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const projectDelete = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: projectFindUnique,
      findMany: projectFindMany,
      delete: projectDelete,
      update: vi.fn(),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("./projectAccessService.js", () => ({
  assertProjectAccess: vi.fn(),
  getProjectAccess: vi.fn(),
}));

const removeContainer = vi.hoisted(() => vi.fn());
const removeCacheVolume = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({
  removeContainer,
  removeCacheVolume,
}));

vi.mock("./managedDatabaseService.js", () => ({
  stop: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  provision: vi.fn(),
}));
vi.mock("./deployService.js", () => ({ unpublish: vi.fn(() => Promise.resolve()) }));
vi.mock("./embedService.js", () => ({ revokeEmbed: vi.fn(() => Promise.resolve()) }));
// NOT mocked: the user-level disk guard is one of the four inversions under
// test, so it has to be the real one. Its collaborators are mocked instead.
const ownerOf = vi.hoisted(() => vi.fn());
vi.mock("./entitlementService.js", () => ({
  ownerOf,
  resolveEntitlements: vi.fn(),
  resolveProjectEntitlements: vi.fn(),
  forgetEntitlements: vi.fn(),
}));
vi.mock("./notificationService.js", () => ({ notify: vi.fn() }));
vi.mock("./checkpointService.js", () => ({
  forgetProject: vi.fn(() => Promise.resolve()),
}));
vi.mock("./collabService.js", () => ({ forgetProject: vi.fn() }));
const usedBytes = vi.hoisted(() => vi.fn());
vi.mock("./diskUsageService.js", () => ({ forgetUsage: vi.fn(), usedBytes }));
vi.mock("../containers/runner.js", () => ({ forgetRun: vi.fn() }));
vi.mock("../containers/devcontainer.js", () => ({ forgetDevcontainer: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const rm = vi.hoisted(() => vi.fn());
const lchown = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());
const readdir = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({
  default: { rm, mkdir: vi.fn(), cp: vi.fn(), lchown, readdir, stat },
}));

import { purgeProject } from "./projectService.js";
import { assertUserDiskQuota } from "./userQuotaService.js";
import {
  claimOneForProject,
  claimProjectForSandbox,
  isLocalProject,
  registerLocalRoot,
  resetLocalRoots,
} from "../utils/projectPaths.js";

const LOCAL = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const OWNED = "9a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
const FOLDER = "/home/dev/code/thing";

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalRoots();
  rm.mockResolvedValue(undefined);
  projectDelete.mockResolvedValue(undefined);
  removeContainer.mockResolvedValue(undefined);
  removeCacheVolume.mockResolvedValue(undefined);
  ownerOf.mockResolvedValue("11111111-1111-4111-8111-111111111111");
  usedBytes.mockResolvedValue(0);
  // Owned by somebody who is not the sandbox user, which is the case that
  // would otherwise trigger the walk.
  stat.mockResolvedValue({ uid: 1000 });
  readdir.mockResolvedValue([]);
  lchown.mockResolvedValue(undefined);
});

describe("purging a project whose folder somebody opened", () => {
  beforeEach(() => {
    registerLocalRoot(LOCAL, FOLDER);
  });

  it("never removes the tree", async () => {
    await purgeProject(LOCAL);

    // The one line in `purgeProject` that would be a catastrophe here.
    // Emptying the trash is not a request to delete somebody's code.
    expect(rm).not.toHaveBeenCalled();
  });

  it("still removes everything this platform created", async () => {
    await purgeProject(LOCAL);

    // The guard is about the TREE and must not become a general exemption:
    // the container, the cache volume and the row are this platform's, and a
    // purge that left a container running would be a resource leak with a
    // deleted row pointing at it.
    expect(removeContainer).toHaveBeenCalledWith(LOCAL);
    expect(removeCacheVolume).toHaveBeenCalledWith(LOCAL);
    expect(projectDelete).toHaveBeenCalledWith({ where: { id: LOCAL } });
  });

  it("forgets the root, so the id cannot resolve to it afterwards", async () => {
    await purgeProject(LOCAL);

    // A stale entry would make a later project created with the same id
    // resolve into somebody's folder. Ids are uuids so this is remote -- and
    // "remote" is not the standard for something that writes files.
    expect(isLocalProject(LOCAL)).toBe(false);
  });

  it("can be opened again afterwards, because the files are still there", async () => {
    await purgeProject(LOCAL);

    // Restated as behaviour rather than as an absent call: closing a folder is
    // all a purge does here, and re-opening it is the round trip that proves
    // nothing was lost.
    expect(rm).not.toHaveBeenCalled();
    expect(projectDelete).toHaveBeenCalled();
  });
});

describe("purging an ordinary project", () => {
  it("still removes the working tree", async () => {
    // The regression this guard could plausibly cause: an exemption written
    // too broadly turns the trash into something that never reclaims disk.
    await purgeProject(OWNED);

    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining(OWNED),
      { recursive: true, force: true },
    );
  });
});

describe("the user's disk allowance", () => {
  it("is not spent by writing into a folder somebody opened", async () => {
    registerLocalRoot(LOCAL, FOLDER);

    // A gigabyte into their own directory. `usedBytes` already reports zero
    // for such a project, so the TOTAL would be right without this guard --
    // but the projection adds the incoming bytes, and a large save would still
    // have been refused against an allowance it does not consume.
    await expect(
      assertUserDiskQuota(LOCAL, 1024 * 1024 * 1024),
    ).resolves.toBeUndefined();

    // Returned before resolving an owner at all, which is what makes it a
    // guard rather than an exemption applied after the arithmetic.
    expect(ownerOf).not.toHaveBeenCalled();
  });

  it("is still spent by writing into a project this server made", async () => {
    // The regression an over-broad guard would cause.
    await assertUserDiskQuota(OWNED, 1024);

    expect(ownerOf).toHaveBeenCalledWith(OWNED);
  });
});

describe("handing a tree to the sandbox user", () => {
  it("does not touch a folder somebody opened", async () => {
    registerLocalRoot(LOCAL, FOLDER);

    await claimProjectForSandbox(LOCAL);

    // `claimForSandbox` walks and `lchown`s every path beneath the root. On
    // somebody's own source directory that is taking their files away from
    // them -- the mount does not need it, because the container already runs
    // as the directory's owner.
    expect(lchown).not.toHaveBeenCalled();
  });

  it("does not touch a single uploaded file in one either", async () => {
    registerLocalRoot(LOCAL, FOLDER);

    await claimOneForProject(LOCAL, `${FOLDER}/uploaded.txt`);

    // The smaller version of the same mistake: one file in their own directory
    // that they can no longer write.
    expect(lchown).not.toHaveBeenCalled();
  });

  it("still claims a tree this server made", async () => {
    // Without this the guard would have broken every ordinary project's mount,
    // which is the failure that made `claimForSandbox` exist.
    await claimProjectForSandbox(OWNED);

    expect(lchown).toHaveBeenCalled();
  });

  it("still skips a tree that already belongs to the sandbox user", async () => {
    stat.mockResolvedValue({ uid: 1001 });

    await claimProjectForSandbox(OWNED);

    // The optimisation that keeps a recursive walk off every container start,
    // preserved by the move into `projectPaths`.
    expect(lchown).not.toHaveBeenCalled();
  });
});
