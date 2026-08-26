import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const projectAccessService = vi.hoisted(() => ({ assertProjectAccess: vi.fn() }));
const git = vi.hoisted(() => ({
  status: vi.fn(),
  init: vi.fn(),
  diff: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  commit: vi.fn(),
  history: vi.fn(),
  branches: vi.fn(),
  discard: vi.fn(),
  applyHunks: vi.fn(),
  remotes: vi.fn(),
  addRemote: vi.fn(),
  removeRemote: vi.fn(),
  fetchRemote: vi.fn(),
  pullRemote: vi.fn(),
  pushRemote: vi.fn(),
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
}));
const forgetProject = vi.hoisted(() => vi.fn());
const dropDoc = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("../service/projectAccessService.js", () => projectAccessService);
vi.mock("../service/gitService.js", () => git);
/** Whether the project is the owner's alone, which is what gates pushing. */
const collaboratorCount = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { findUnique },
    projectCollaborator: { count: collaboratorCount },
    project: { findUnique: projectFindUnique },
  },
}));
vi.mock("../service/collabService.js", () => ({ forgetProject, dropDoc }));

import {
  gitBranchController,
  gitDiscardController,
  gitFetchController,
  gitHunksController,
  gitPullController,
  gitPushController,
  gitRemoteController,
  gitRemotesController,
  gitBranchesController,
  gitCommitController,
  gitDiffController,
  gitInitController,
  gitLogController,
  gitStageController,
  gitStatusController,
  gitUnstageController,
} from "./gitController.js";
import { apiApp, bearer, TEST_PROJECT, TEST_USER } from "../test/apiHarness.js";
import { ForbiddenError } from "../utils/errors.js";

const app = apiApp([
  { method: "get", path: "/p/:projectId/git/status", handler: gitStatusController },
  { method: "get", path: "/p/:projectId/git/diff", handler: gitDiffController },
  { method: "get", path: "/p/:projectId/git/log", handler: gitLogController },
  { method: "post", path: "/p/:projectId/git/init", handler: gitInitController },
  { method: "post", path: "/p/:projectId/git/stage", handler: gitStageController },
  { method: "post", path: "/p/:projectId/git/unstage", handler: gitUnstageController },
  { method: "post", path: "/p/:projectId/git/commit", handler: gitCommitController },
  { method: "get", path: "/p/:projectId/git/branches", handler: gitBranchesController },
  { method: "post", path: "/p/:projectId/git/branch", handler: gitBranchController },
  { method: "post", path: "/p/:projectId/git/discard", handler: gitDiscardController },
  { method: "post", path: "/p/:projectId/git/hunks", handler: gitHunksController },
  { method: "get", path: "/p/:projectId/git/remotes", handler: gitRemotesController },
  { method: "post", path: "/p/:projectId/git/remote", handler: gitRemoteController },
  { method: "post", path: "/p/:projectId/git/fetch", handler: gitFetchController },
  { method: "post", path: "/p/:projectId/git/pull", handler: gitPullController },
  { method: "post", path: "/p/:projectId/git/push", handler: gitPushController },
]);

const STATUS = { branch: "main", staged: [], unstaged: [] };

beforeEach(() => {
  vi.clearAllMocks();
  projectAccessService.assertProjectAccess.mockResolvedValue({ id: TEST_PROJECT });
  git.status.mockResolvedValue(STATUS);
  git.branches.mockResolvedValue([{ name: "main", current: true }]);
  git.remotes.mockResolvedValue([
    { name: "origin", url: "https://github.com/a/b.git" },
  ]);
  findUnique.mockResolvedValue({ email: TEST_USER.email });
  // Sole occupant by default: no collaborators, no outstanding share link.
  collaboratorCount.mockResolvedValue(0);
  projectFindUnique.mockResolvedValue({ shareToken: null });
});

const auth = () => ({ Authorization: bearer() });

describe("access levels", () => {
  /** Reading history is a viewer's business; anything that writes to the
   *  repository is not — the same line the editor draws. */
  it.each([
    ["status", "get", "/status", undefined],
    ["diff", "get", "/diff?path=a.txt", undefined],
    ["log", "get", "/log", undefined],
  ])("asks for viewer access on %s", async (_name, method, path) => {
    await request(app)[method as "get"](`/p/${TEST_PROJECT}/git${path}`).set(auth());

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "viewer",
    );
  });

  it.each([
    ["init", "/init", {}],
    ["stage", "/stage", { paths: ["a.txt"] }],
    ["unstage", "/unstage", { paths: ["a.txt"] }],
    ["commit", "/commit", { message: "work" }],
  ])("asks for editor access on %s", async (_name, path, body) => {
    git.commit.mockResolvedValue([]);
    git.init.mockResolvedValue({});

    await request(app).post(`/p/${TEST_PROJECT}/git${path}`).set(auth()).send(body);

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("does not run git when the access check refuses", async () => {
    projectAccessService.assertProjectAccess.mockRejectedValue(new ForbiddenError());

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(response.status).toBe(403);
    expect(git.stage).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await request(app).get(`/p/${TEST_PROJECT}/git/status`);

    expect(response.status).toBe(401);
    expect(git.status).not.toHaveBeenCalled();
  });

  it("rejects a project id that is not a uuid", async () => {
    const response = await request(app).get("/p/nonsense/git/status").set(auth());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_PROJECT_ID");
  });
});

/** git itself would refuse most of these, but relying on that puts a
 *  client-supplied string on a command line first. */
describe("path validation", () => {
  const BAD_PATHS = [
    ["an absolute posix path", "/etc/passwd"],
    ["a parent traversal", "../../../etc/passwd"],
    ["a traversal in the middle", "src/../../secrets.txt"],
    ["a windows-separator traversal", "src\\..\\..\\secrets.txt"],
    // A leading dash is read by git as an option, not a path.
    ["an option-looking path", "--upload-pack=touch /tmp/pwned"],
    ["an empty path", ""],
    ["an over-long path", "a".repeat(1025)],
  ] as const;

  it.each(BAD_PATHS)("refuses to stage %s", async (_label, badPath) => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: [badPath] });

    expect(response.status).toBe(400);
    expect(git.stage).not.toHaveBeenCalled();
  });

  it.each(BAD_PATHS)("refuses to diff %s", async (_label, badPath) => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/git/diff`)
      .query({ path: badPath })
      .set(auth());

    expect(response.status).toBe(400);
    expect(git.diff).not.toHaveBeenCalled();
  });

  it("rejects a batch where only one path is bad", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: ["fine.txt", "also/fine.txt", "../escape.txt"] });

    expect(response.status).toBe(400);
    expect(git.stage).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty list", { paths: [] }],
    ["no list at all", {}],
    ["more paths than the cap", { paths: Array.from({ length: 501 }, (_, i) => `f${String(i)}`) }],
    ["a list of non-strings", { paths: [1, 2] }],
  ])("rejects %s", async (_label, body) => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send(body);

    expect(response.status).toBe(400);
    expect(git.stage).not.toHaveBeenCalled();
  });

  it("accepts an ordinary nested path", async () => {
    git.stage.mockResolvedValue(undefined);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: ["src/components/App.tsx"] });

    expect(response.status).toBe(200);
    expect(git.stage).toHaveBeenCalledWith(TEST_PROJECT, ["src/components/App.tsx"]);
  });

  it("accepts a dotfile and a path containing '..' inside a name", async () => {
    git.stage.mockResolvedValue(undefined);

    await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: [".gitignore", "weird..name.txt"] });

    expect(git.stage).toHaveBeenCalledWith(TEST_PROJECT, [
      ".gitignore",
      "weird..name.txt",
    ]);
  });
});

describe("gitDiffController", () => {
  it("reads the staged flag as a boolean", async () => {
    git.diff.mockResolvedValue("@@ -1 +1 @@");

    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/git/diff`)
      .query({ path: "a.txt", staged: "true" })
      .set(auth());

    expect(response.status).toBe(200);
    expect(git.diff).toHaveBeenCalledWith(TEST_PROJECT, "a.txt", true);
    expect(response.body.data).toMatchObject({ path: "a.txt", staged: true });
  });

  it("defaults staged to false when absent", async () => {
    git.diff.mockResolvedValue("");

    await request(app)
      .get(`/p/${TEST_PROJECT}/git/diff`)
      .query({ path: "a.txt" })
      .set(auth());

    expect(git.diff).toHaveBeenCalledWith(TEST_PROJECT, "a.txt", false);
  });

  it("rejects a staged value that is neither true nor false", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/git/diff`)
      .query({ path: "a.txt", staged: "maybe" })
      .set(auth());

    expect(response.status).toBe(400);
    expect(git.diff).not.toHaveBeenCalled();
  });
});

describe("gitCommitController", () => {
  /** A shared project has several people committing into one repository, so the
   *  commit is attributed to whoever made it rather than to the owner. */
  it("attributes the commit to the caller, not the project owner", async () => {
    findUnique.mockResolvedValue({ email: "committer@example.com" });
    git.commit.mockResolvedValue([{ hash: "abc" }]);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/commit`)
      .set(auth())
      .send({ message: "a change" });

    expect(response.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: TEST_USER.sub },
      select: { email: true },
    });
    expect(git.commit).toHaveBeenCalledWith(TEST_PROJECT, "a change", {
      name: "committer",
      email: "committer@example.com",
    });
  });

  it("still commits when the user row has vanished", async () => {
    findUnique.mockResolvedValue(null);
    git.commit.mockResolvedValue([]);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/commit`)
      .set(auth())
      .send({ message: "a change" });

    expect(response.status).toBe(200);
    expect(git.commit).toHaveBeenCalledWith(
      TEST_PROJECT,
      "a change",
      expect.objectContaining({ email: "unknown@example.com" }),
    );
  });

  it.each([
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   " }],
    ["no message", {}],
    ["an over-long message", { message: "x".repeat(2001) }],
  ])("rejects %s", async (_label, body) => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/commit`)
      .set(auth())
      .send(body);

    expect(response.status).toBe(400);
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("returns the status alongside the new commits", async () => {
    git.commit.mockResolvedValue([{ hash: "abc" }]);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/commit`)
      .set(auth())
      .send({ message: "a change" });

    expect(response.body.data).toEqual({ status: STATUS, commits: [{ hash: "abc" }] });
  });
});

describe("gitLogController", () => {
  it.each([
    ["no limit", undefined, 20],
    ["a limit of 5", "5", 5],
    ["a limit above the cap", "5000", 100],
    ["a non-numeric limit", "lots", 20],
    ["a limit of zero", "0", 20],
  ])("asks for %s", async (_label, limit, expected) => {
    git.history.mockResolvedValue([]);

    await request(app)
      .get(`/p/${TEST_PROJECT}/git/log`)
      .query(limit === undefined ? {} : { limit })
      .set(auth());

    expect(git.history).toHaveBeenCalledWith(TEST_PROJECT, expected);
  });
});

describe("gitStageController / gitUnstageController", () => {
  it("returns the refreshed status after staging", async () => {
    git.stage.mockResolvedValue(undefined);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/stage`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(response.body.data).toEqual(STATUS);
  });

  it("returns the refreshed status after unstaging", async () => {
    git.unstage.mockResolvedValue(undefined);

    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/unstage`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(response.status).toBe(200);
    expect(git.unstage).toHaveBeenCalledWith(TEST_PROJECT, ["a.txt"]);
    expect(response.body.data).toEqual(STATUS);
  });
});

describe("branches", () => {
  it("lists them for a viewer", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/git/branches`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ name: "main", current: true }]);
    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "viewer",
    );
  });

  it("needs editor access to create or switch", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature" });

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("switches to an existing branch by default", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature" });

    expect(git.switchBranch).toHaveBeenCalledWith(TEST_PROJECT, "feature");
    expect(git.createBranch).not.toHaveBeenCalled();
  });

  it("creates one when asked to", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature", create: true });

    expect(git.createBranch).toHaveBeenCalledWith(TEST_PROJECT, "feature");
    expect(git.switchBranch).not.toHaveBeenCalled();
  });

  it("drops shared documents, so none writes the old branch back", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature" });

    expect(forgetProject).toHaveBeenCalledWith(TEST_PROJECT);
  });

  it("answers with the resulting status and branch list", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature" });

    expect(response.body.data.status).toEqual(STATUS);
    expect(response.body.data.branches).toEqual([{ name: "main", current: true }]);
  });

  it("refuses a name that starts with a dash", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "--upload-pack=evil" });

    expect(response.status).toBe(400);
    expect(git.switchBranch).not.toHaveBeenCalled();
    // Nothing was touched, so nothing needed dropping.
    expect(forgetProject).not.toHaveBeenCalled();
  });

  it("refuses an empty name", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "   " });

    expect(response.status).toBe(400);
    expect(git.switchBranch).not.toHaveBeenCalled();
  });

  it("keeps documents when the switch itself fails", async () => {
    git.switchBranch.mockRejectedValue(new ForbiddenError("dirty"));

    await request(app)
      .post(`/p/${TEST_PROJECT}/git/branch`)
      .set(auth())
      .send({ name: "feature" });

    expect(forgetProject).not.toHaveBeenCalled();
  });
});

describe("discard", () => {
  it("needs editor access", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("discards the named paths", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt", "dir/b.txt"] });

    expect(git.discard).toHaveBeenCalledWith(TEST_PROJECT, ["a.txt", "dir/b.txt"]);
  });

  it("drops each discarded file's shared document", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt", "dir/b.txt"] });

    // Otherwise a live document would write the discarded text straight back.
    expect(dropDoc).toHaveBeenCalledWith(TEST_PROJECT, "a.txt");
    expect(dropDoc).toHaveBeenCalledWith(TEST_PROJECT, "dir/b.txt");
  });

  it("leaves other files' documents alone", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(dropDoc).toHaveBeenCalledTimes(1);
    expect(forgetProject).not.toHaveBeenCalled();
  });

  it("answers with the status afterwards", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(STATUS);
  });

  it("refuses a path that climbs out of the project", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["../../etc/passwd"] });

    expect(response.status).toBe(400);
    expect(git.discard).not.toHaveBeenCalled();
  });

  it("refuses a path that looks like a flag", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["--force"] });

    expect(response.status).toBe(400);
    expect(git.discard).not.toHaveBeenCalled();
  });

  it("refuses an empty list", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: [] });

    expect(response.status).toBe(400);
    expect(git.discard).not.toHaveBeenCalled();
  });

  it("keeps documents when the discard itself fails", async () => {
    git.discard.mockRejectedValue(new ForbiddenError("nope"));

    await request(app)
      .post(`/p/${TEST_PROJECT}/git/discard`)
      .set(auth())
      .send({ paths: ["a.txt"] });

    expect(dropDoc).not.toHaveBeenCalled();
  });
});

describe("hunks", () => {
  const post = (body: object) =>
    request(app).post(`/p/${TEST_PROJECT}/git/hunks`).set(auth()).send(body);

  it("needs editor access", async () => {
    await post({ path: "f.txt", indexes: [0] });

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  it("stages the chosen hunks", async () => {
    await post({ path: "f.txt", indexes: [0, 2] });

    expect(git.applyHunks).toHaveBeenCalledWith(
      TEST_PROJECT,
      "f.txt",
      [0, 2],
      false,
    );
  });

  it("unstages them when reversed", async () => {
    await post({ path: "f.txt", indexes: [1], reverse: true });

    expect(git.applyHunks).toHaveBeenCalledWith(TEST_PROJECT, "f.txt", [1], true);
  });

  it("answers with the status afterwards", async () => {
    const response = await post({ path: "f.txt", indexes: [0] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(STATUS);
  });

  it("refuses patch text in place of indexes", async () => {
    // The client says WHICH hunks, never what is in them.
    const response = await post({
      path: "f.txt",
      indexes: ["@@ -1 +1 @@\n+evil"],
    });

    expect(response.status).toBe(400);
    expect(git.applyHunks).not.toHaveBeenCalled();
  });

  it("refuses a negative index", async () => {
    const response = await post({ path: "f.txt", indexes: [-1] });

    expect(response.status).toBe(400);
    expect(git.applyHunks).not.toHaveBeenCalled();
  });

  it("refuses an empty selection", async () => {
    const response = await post({ path: "f.txt", indexes: [] });

    expect(response.status).toBe(400);
    expect(git.applyHunks).not.toHaveBeenCalled();
  });

  it("refuses a path that climbs out of the project", async () => {
    const response = await post({ path: "../../etc/passwd", indexes: [0] });

    expect(response.status).toBe(400);
    expect(git.applyHunks).not.toHaveBeenCalled();
  });
});

describe("remotes", () => {
  it("lists them for a viewer", async () => {
    const response = await request(app)
      .get(`/p/${TEST_PROJECT}/git/remotes`)
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { name: "origin", url: "https://github.com/a/b.git" },
    ]);
    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "viewer",
    );
  });

  it("needs editor access to add one", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/remote`)
      .set(auth())
      .send({ name: "origin", url: "https://github.com/a/b.git" });

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
    expect(git.addRemote).toHaveBeenCalledWith(
      TEST_PROJECT,
      "origin",
      "https://github.com/a/b.git",
    );
  });

  it("removes one when asked", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/remote`)
      .set(auth())
      .send({ name: "origin", remove: true });

    expect(git.removeRemote).toHaveBeenCalledWith(TEST_PROJECT, "origin");
    expect(git.addRemote).not.toHaveBeenCalled();
  });

  it("refuses to add one with no URL", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/remote`)
      .set(auth())
      .send({ name: "origin" });

    expect(response.status).toBe(400);
    expect(git.addRemote).not.toHaveBeenCalled();
  });

  it("refuses a name that would be read as a flag", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/remote`)
      .set(auth())
      .send({ name: "--exec=evil", url: "https://h/r.git" });

    expect(response.status).toBe(400);
    expect(git.addRemote).not.toHaveBeenCalled();
  });
});

describe("fetch and pull", () => {
  it("fetches without touching any shared document", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/fetch`)
      .set(auth())
      .send({ name: "origin" });

    expect(git.fetchRemote).toHaveBeenCalledWith(TEST_PROJECT, "origin");
    // A fetch changes no file, so nothing needs dropping.
    expect(forgetProject).not.toHaveBeenCalled();
  });

  it("pulls a named branch", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/pull`)
      .set(auth())
      .send({ name: "origin", branch: "main" });

    expect(git.pullRemote).toHaveBeenCalledWith(TEST_PROJECT, "origin", "main");
  });

  it("drops shared documents after a pull, which rewrote the worktree", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/pull`)
      .set(auth())
      .send({ name: "origin", branch: "main" });

    expect(forgetProject).toHaveBeenCalledWith(TEST_PROJECT);
  });

  it("keeps documents when the pull was refused", async () => {
    git.pullRemote.mockRejectedValue(new ForbiddenError("dirty"));

    await request(app)
      .post(`/p/${TEST_PROJECT}/git/pull`)
      .set(auth())
      .send({ name: "origin", branch: "main" });

    expect(forgetProject).not.toHaveBeenCalled();
  });

  it("refuses a pull with no branch named", async () => {
    const response = await request(app)
      .post(`/p/${TEST_PROJECT}/git/pull`)
      .set(auth())
      .send({ name: "origin" });

    expect(response.status).toBe(400);
    expect(git.pullRemote).not.toHaveBeenCalled();
  });

  it("needs editor access to pull", async () => {
    await request(app)
      .post(`/p/${TEST_PROJECT}/git/pull`)
      .set(auth())
      .send({ name: "origin", branch: "main" });

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });
});

describe("push", () => {
  const body = { name: "origin", branch: "main", token: "secret-value" };

  const post = (over: object = {}) =>
    request(app)
      .post(`/p/${TEST_PROJECT}/git/push`)
      .set(auth())
      .send({ ...body, ...over });

  it("is the owner's alone, not an editor's", async () => {
    await post();

    // It spends the OWNER's credential, so an editor cannot ask for it.
    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "owner",
    );
  });

  it("pushes when the project is the owner's alone", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(git.pushRemote).toHaveBeenCalledWith(
      TEST_PROJECT,
      "origin",
      "main",
      "secret-value",
    );
  });

  it("refuses when the project has a collaborator", async () => {
    collaboratorCount.mockResolvedValue(1);

    const response = await post();

    // Everyone works in one container, so the token would be readable by them.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PROJECT_IS_SHARED");
    expect(git.pushRemote).not.toHaveBeenCalled();
  });

  it("refuses while a share link is outstanding", async () => {
    projectFindUnique.mockResolvedValue({ shareToken: "an-unredeemed-link" });

    const response = await post();

    // An invitation nobody has taken up yet can be taken up mid-push.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PROJECT_IS_SHARED");
    expect(git.pushRemote).not.toHaveBeenCalled();
  });

  it("says where pushing does still work", async () => {
    collaboratorCount.mockResolvedValue(1);

    const response = await post();

    expect(response.body.message).toMatch(/terminal/i);
  });

  it("refuses without a token rather than pushing unauthenticated", async () => {
    const response = await post({ token: undefined });

    expect(response.status).toBe(400);
    expect(git.pushRemote).not.toHaveBeenCalled();
  });

  it("refuses a remote or branch that would be read as a flag", async () => {
    expect((await post({ name: "--exec=evil" })).status).toBe(400);
    expect((await post({ branch: "--upload-pack=evil" })).status).toBe(400);
    expect(git.pushRemote).not.toHaveBeenCalled();
  });

  it("never echoes the token back to the caller", async () => {
    const response = await post();

    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });

  it("does not leak the token when git fails", async () => {
    // A failure message is the likeliest place for one to escape.
    git.pushRemote.mockRejectedValue(new ForbiddenError("denied"));

    const response = await post();

    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });
});
