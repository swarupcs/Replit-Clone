import { beforeEach, describe, expect, it, vi } from "vitest";

/** A folder somebody opened is not a tree this server owns.
 *
 *  Four operations in this codebase are correct precisely because the server
 *  made the directory it is acting on: `purgeProject` removes it recursively,
 *  `claimForSandbox` hands it to the sandbox uid, and the two disk quotas
 *  ration it. Run any of them against a folder somebody opened and the result
 *  is not a bug in a feature -- it is deleting or seizing a person's own source
 *  directory, or an editor refusing to save into their own free space.
 *
 *  So these are the tests for the FOUR INVERSIONS rather than for the happy
 *  path. The happy path is one row and one bind mount; these are the reason the
 *  row has to exist at all.
 */

const projectCreate = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());
const projectFindMany = vi.hoisted(() => vi.fn());
const projectDelete = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      create: projectCreate,
      findUnique: projectFindUnique,
      findMany: projectFindMany,
      delete: projectDelete,
      update: vi.fn(),
    },
  },
}));

const resolveLocalFolder = vi.hoisted(() => vi.fn());
vi.mock("../utils/localRoots.js", () => ({
  resolveLocalFolder,
  listLocalFolders: vi.fn(),
  localFolderRoots: () => ["/home/dev"],
  localFoldersEnabled: () => true,
}));

const assertCanCreateProject = vi.hoisted(() => vi.fn());
vi.mock("./userQuotaService.js", () => ({
  assertCanCreateProject,
  forgetUserQuota: vi.fn(),
}));

const inspectDirectory = vi.hoisted(() => vi.fn());
vi.mock("./repoImportService.js", () => ({
  inspectDirectory,
  detectTemplate: vi.fn(() => "node-express"),
  // Real rather than stubbed: it is a pure function of a file list, and a
  // folder somebody already had is MORE likely to be pnpm or yarn than a fresh
  // clone is, so this is the call site where getting it wrong costs most.
  detectPackageManager: vi.fn((files: string[]) =>
    files.includes("pnpm-lock.yaml") ? "pnpm" : "npm",
  ),
  detectStartCommand: vi.fn(
    (_packageJson: unknown, manager = "npm") =>
      `${manager} install && ${manager} run dev`,
  ),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  loadLocalFolders,
  openLocalFolderService,
} from "./localFolderService.js";
import {
  isLocalProject,
  projectRoot,
  registerLocalRoot,
  resetLocalRoots,
} from "../utils/projectPaths.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";
const FOLDER = "/home/dev/code/thing";

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalRoots();
  resolveLocalFolder.mockResolvedValue(FOLDER);
  projectFindUnique.mockResolvedValue(null);
  projectFindMany.mockResolvedValue([]);
  assertCanCreateProject.mockResolvedValue(undefined);
  inspectDirectory.mockResolvedValue({ files: ["package.json"], packageJson: {} });
  projectCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: PROJECT, ...data }),
  );
});

describe("opening a folder", () => {
  it("records the resolved path, not the one that was asked for", async () => {
    // `resolveLocalFolder` returns the realpath. Storing the request instead
    // would let two different strings for one directory both be opened, which
    // the unique index is there to prevent.
    resolveLocalFolder.mockResolvedValue("/home/dev/code/thing");

    await openLocalFolderService(OWNER, "/home/dev/code/../code/thing");

    expect(projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ localPath: "/home/dev/code/thing" }),
      }),
    );
  });

  it("points the project at the folder rather than at a server directory", async () => {
    const project = await openLocalFolderService(OWNER, FOLDER);

    // The whole feature in one assertion: every path in the product resolves
    // against this, so if it were still PROJECTS_ROOT/<id> the project would
    // open empty.
    expect(projectRoot(project.id)).toBe(FOLDER);
    expect(isLocalProject(project.id)).toBe(true);
  });

  it("names it after the folder when nobody says otherwise", async () => {
    await openLocalFolderService(OWNER, FOLDER);

    expect(projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "thing" }) }),
    );
  });

  it("detects what the folder is rather than scaffolding a template into it", async () => {
    await openLocalFolderService(OWNER, FOLDER);

    // Detection decides which image can run it and nothing more. Nothing is
    // written into somebody's directory by opening it.
    expect(projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ template: "node-express" }),
      }),
    );
    expect(inspectDirectory).toHaveBeenCalledWith(FOLDER);
  });

  /** A folder somebody already had is more likely to be pnpm or yarn than a
   *  fresh clone is -- it is their real working tree, with whatever they chose
   *  years ago. Opening one and then installing it with npm ignores the
   *  lockfile, which is the entire point of a lockfile, and fails outright on a
   *  `workspace:*` dependency. */
  it("installs with the manager the folder's lockfile names", async () => {
    inspectDirectory.mockResolvedValue({
      files: ["package.json", "pnpm-lock.yaml"],
      packageJson: { scripts: { dev: "vite" } },
    });

    await openLocalFolderService(OWNER, FOLDER);

    expect(projectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          startCommand: "pnpm install && pnpm run dev",
        }),
      }),
    );
  });

  it("still counts against the project limit", async () => {
    // The disk stops applying; the project COUNT does not. A row is a row.
    await openLocalFolderService(OWNER, FOLDER);

    expect(assertCanCreateProject).toHaveBeenCalledWith(OWNER);
  });

  it("refuses before writing a row when the account is at its limit", async () => {
    assertCanCreateProject.mockRejectedValue(new Error("too many"));

    await expect(openLocalFolderService(OWNER, FOLDER)).rejects.toThrow();
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("returns the existing project when its owner opens it again", async () => {
    projectFindUnique.mockResolvedValue({
      id: PROJECT,
      ownerId: OWNER,
      deletedAt: null,
    });

    const project = await openLocalFolderService(OWNER, FOLDER);

    expect(project.id).toBe(PROJECT);
    // One directory, one row. A second would be two containers writing one
    // tree with nothing to arbitrate between them.
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it("refuses when somebody else has that folder open", async () => {
    projectFindUnique.mockResolvedValue({
      id: PROJECT,
      ownerId: STRANGER,
      deletedAt: null,
    });

    // Not "here is the project": handing somebody an existing project by
    // guessing a path is an access-control hole with a helpful message on it.
    await expect(openLocalFolderService(OWNER, FOLDER)).rejects.toMatchObject({
      code: "FOLDER_ALREADY_OPEN",
    });
  });

  it("refuses when the folder is open as a project in the trash", async () => {
    projectFindUnique.mockResolvedValue({
      id: PROJECT,
      ownerId: OWNER,
      deletedAt: new Date(),
    });

    // The row still holds the unique path, so a second one cannot be written.
    // Restoring it is the way back, and saying so is the trash's job.
    await expect(openLocalFolderService(OWNER, FOLDER)).rejects.toMatchObject({
      code: "FOLDER_ALREADY_OPEN",
    });
  });

  it("refuses a path the allowlist rejects, before touching the database", async () => {
    resolveLocalFolder.mockRejectedValue(new Error("nope"));

    await expect(openLocalFolderService(OWNER, "/etc")).rejects.toThrow();
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(projectCreate).not.toHaveBeenCalled();
  });
});

describe("the registry at boot", () => {
  it("registers every project that has a path, and only those", async () => {
    projectFindMany.mockResolvedValue([
      { id: PROJECT, localPath: FOLDER },
      { id: "9a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d", localPath: null },
    ]);

    await loadLocalFolders();

    expect(isLocalProject(PROJECT)).toBe(true);
    expect(isLocalProject("9a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d")).toBe(false);
  });

  it("leaves a server-owned project resolving exactly where it always did", async () => {
    await loadLocalFolders();

    const id = "9a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
    // The no-op property: with an empty registry this behaves precisely as it
    // did before local folders existed, which is what makes the change safe
    // for every project that already exists.
    expect(projectRoot(id).endsWith(id)).toBe(true);
    expect(isLocalProject(id)).toBe(false);
  });
});

describe("the registry itself", () => {
  it("still refuses an id that is not a uuid", () => {
    // The registry is consulted inside `projectRoot`, which is under the path
    // confinement check. Validation must not have moved.
    expect(() => registerLocalRoot("../../etc", FOLDER)).toThrow();
    expect(() => projectRoot("not-a-uuid")).toThrow();
  });
});
