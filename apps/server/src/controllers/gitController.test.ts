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

/** The committer's signing identity, looked up on every commit (plan.md
 *  §11.9). Null here, which is the ordinary case: signing is opt-in and every
 *  assertion in this file is about the UNSIGNED path. `gitSigning.test.ts`
 *  covers the other one. */
const signingFor = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("../service/personalizationService.js", () => ({ signingFor }));
/** Whether the project is the owner's alone, which is what gates pushing. */
const collaboratorCount = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());

const githubToken = vi.hoisted(() => vi.fn());
/** Whether the caller has a GitHub connection to pay for a push. */
const githubConnectionFindUnique = vi.hoisted(() => vi.fn());

/** Only the credential is stubbed. `parseGithubRemote` is a pure function the
 *  controller's behaviour is defined in terms of, so replacing it would leave
 *  these tests asserting against a stand-in rather than the real rules. */
vi.mock("../service/githubService.js", async () => ({
  ...(await vi.importActual<typeof import("../service/githubService.js")>(
    "../service/githubService.js",
  )),
  githubToken,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { findUnique },
    projectCollaborator: { count: collaboratorCount },
    project: { findUnique: projectFindUnique },
    githubConnection: { findUnique: githubConnectionFindUnique },
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
  gitSyncController,
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
  githubRepoController,
} from "./gitController.js";
import { apiApp, bearer, TEST_PROJECT, TEST_USER } from "../test/apiHarness.js";
import { BadRequestError, ForbiddenError } from "../utils/errors.js";

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
  { method: "post", path: "/p/:projectId/git/sync", handler: gitSyncController },
  {
    method: "get",
    path: "/p/:projectId/github/repo",
    handler: githubRepoController,
  },
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
  githubConnectionFindUnique.mockResolvedValue({ userId: TEST_USER.sub });
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
    expect(git.commit).toHaveBeenCalledWith(
      TEST_PROJECT,
      "a change",
      { name: "committer", email: "committer@example.com" },
      // No signing identity: signing is opt-in, and null is what every commit
      // before §11.9 effectively passed.
      null,
    );
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
      null,
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

  it("falls back to the connected GitHub account when no token is sent", async () => {
    githubToken.mockResolvedValue("from-the-connection");
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://github.com/a/b.git" },
    ]);

    const response = await post({ token: undefined });

    expect(response.status).toBe(200);
    expect(git.pushRemote).toHaveBeenCalledWith(
      expect.any(String),
      "origin",
      "main",
      "from-the-connection",
    );
  });

  it("prefers a token that was sent over the stored connection", async () => {
    // Someone pasting one is pushing to a forge this server knows nothing
    // about; their explicit choice must not be overridden.
    githubToken.mockResolvedValue("from-the-connection");

    await post({ token: "typed-in" });

    expect(git.pushRemote).toHaveBeenCalledWith(
      expect.any(String),
      "origin",
      "main",
      "typed-in",
    );
    expect(githubToken).not.toHaveBeenCalled();
  });

  /** git's credential helper answers whatever host git asks it about, so
   *  spending the stored GitHub token on a remote that is not GitHub hands
   *  somebody's token to that host. Remotes are added at editor level and may
   *  name any https host. */
  it("refuses to spend the stored token on a remote that is not GitHub", async () => {
    githubToken.mockResolvedValue("from-the-connection");
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://evil.test/mirror.git" },
    ]);

    const response = await post({ token: undefined });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("REMOTE_NOT_GITHUB");
    expect(git.pushRemote).not.toHaveBeenCalled();
    // And the credential is never even read.
    expect(githubToken).not.toHaveBeenCalled();
  });

  it("still lets a pasted token reach a non-GitHub remote", async () => {
    // Choosing to give a credential to a particular remote is exactly what
    // typing one in means.
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://gitlab.com/a/b.git" },
    ]);

    const response = await post({ token: "typed-in" });

    expect(response.status).toBe(200);
    expect(git.pushRemote).toHaveBeenCalledWith(
      expect.any(String),
      "origin",
      "main",
      "typed-in",
    );
  });

  it("refuses when the named remote does not exist at all", async () => {
    githubToken.mockResolvedValue("from-the-connection");
    git.remotes.mockResolvedValue([]);

    expect((await post({ token: undefined })).body.code).toBe("REMOTE_NOT_GITHUB");
  });

  it("refuses with neither a token nor a connection", async () => {
    // The real service throws this when there is nothing stored; the error
    // handler maps it by type, so a look-alike would come back a 500.
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://github.com/a/b.git" },
    ]);
    githubToken.mockRejectedValue(
      new BadRequestError(
        "Connect your GitHub account first.",
        "GITHUB_NOT_CONNECTED",
      ),
    );

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


describe("which GitHub repository a project belongs to", () => {
  const get = () =>
    request(app).get(`/p/${TEST_PROJECT}/github/repo`).set(auth());

  it("derives it from the project's own remotes", async () => {
    // Never from the request: a browser naming the repository is a thing to
    // get wrong or to lie about.
    git.remotes.mockResolvedValue([
      { name: "origin", url: "git@github.com:octocat/hello.git" },
    ]);

    const response = await get();

    expect(response.body.data).toEqual({
      owner: "octocat",
      repo: "hello",
      url: "https://github.com/octocat/hello",
    });
  });

  it("prefers origin over any other remote", async () => {
    // A fork's origin is the fork, which is where a pull request comes from.
    git.remotes.mockResolvedValue([
      { name: "upstream", url: "https://github.com/original/hello.git" },
      { name: "origin", url: "https://github.com/me/hello.git" },
    ]);

    expect((await get()).body.data.owner).toBe("me");
  });

  it("falls back to another GitHub remote when origin is not one", async () => {
    git.remotes.mockResolvedValue([
      { name: "origin", url: "/srv/repos/hello.git" },
      { name: "github", url: "https://github.com/octocat/hello.git" },
    ]);

    expect((await get()).body.data.owner).toBe("octocat");
  });

  it("is null when nothing points at GitHub", async () => {
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://gitlab.com/octocat/hello.git" },
    ]);

    expect((await get()).body.data).toBeNull();
  });

  it("is null with no remotes at all", async () => {
    git.remotes.mockResolvedValue([]);
    expect((await get()).body.data).toBeNull();
  });
});

describe("sync", () => {
  /** The controller reads the status four times — before, after the fetch,
   *  after any pull, and once more to answer with. Sequencing them is what
   *  makes "did it decide to pull" observable at all. */
  const statuses = (...values: Array<Record<string, unknown>>) => {
    git.status.mockReset();
    for (const value of values) {
      git.status.mockResolvedValueOnce({ isRepo: true, branch: "main", ...value });
    }
    // Anything past the sequence is the final read.
    git.status.mockResolvedValue({
      isRepo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      changes: [],
    });
  };

  const sync = (body: Record<string, unknown> = {}) =>
    request(app).post(`/p/${TEST_PROJECT}/git/sync`).set(auth()).send(body);

  /** `vi.clearAllMocks()` clears calls but NOT implementations, and an earlier
   *  test in this file leaves `pullRemote` rejecting for good. These three are
   *  the legs of a sync, so each one states its own success here rather than
   *  inheriting whatever the previous describe block left behind. */
  beforeEach(() => {
    git.fetchRemote.mockResolvedValue(undefined);
    git.pullRemote.mockResolvedValue(undefined);
    git.pushRemote.mockResolvedValue(undefined);
  });

  it("fetches, fast-forwards and pushes in that order", async () => {
    statuses(
      { ahead: 2, behind: 0, changes: [] }, // before
      { ahead: 2, behind: 3, changes: [] }, // after fetch: 3 to pull
      { ahead: 2, behind: 0, changes: [] }, // after pull: 2 to push
    );
    githubToken.mockResolvedValue("gh-token");

    const response = await sync();

    expect(response.status).toBe(200);
    expect(git.fetchRemote).toHaveBeenCalledWith(TEST_PROJECT, "origin");
    expect(git.pullRemote).toHaveBeenCalledWith(TEST_PROJECT, "origin", "main");
    expect(git.pushRemote).toHaveBeenCalledWith(
      TEST_PROJECT,
      "origin",
      "main",
      "gh-token",
    );
    expect(response.body.data).toMatchObject({
      remote: "origin",
      branch: "main",
      pulled: 3,
      pushed: 2,
      pushSkipped: null,
    });

    // The worktree was rewritten under any live shared document.
    expect(forgetProject).toHaveBeenCalledWith(TEST_PROJECT);
  });

  it("does not pull or push when there is nothing to do", async () => {
    statuses(
      { ahead: 0, behind: 0, changes: [] },
      { ahead: 0, behind: 0, changes: [] },
      { ahead: 0, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(git.fetchRemote).toHaveBeenCalled();
    expect(git.pullRemote).not.toHaveBeenCalled();
    expect(git.pushRemote).not.toHaveBeenCalled();
    expect(forgetProject).not.toHaveBeenCalled();
    expect(response.body.data.summary).toContain("Already up to date");
  });

  /** The point of the leg-by-leg result: a pull that worked is not thrown away
   *  because the push half was unavailable. */
  it("keeps a successful pull when the project is shared", async () => {
    collaboratorCount.mockResolvedValue(1);
    statuses(
      { ahead: 1, behind: 2, changes: [] },
      { ahead: 1, behind: 2, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(response.status).toBe(200);
    expect(git.pullRemote).toHaveBeenCalled();
    expect(git.pushRemote).not.toHaveBeenCalled();
    expect(response.body.data).toMatchObject({
      pulled: 2,
      pushed: 0,
      pushSkipped: "PROJECT_IS_SHARED",
    });
  });

  /** An unredeemed share link counts as sharing, exactly as it does for push:
   *  it can be redeemed while the push is in flight. */
  it("treats an outstanding share link as shared", async () => {
    projectFindUnique.mockResolvedValue({ shareToken: "live-token" });
    statuses(
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(git.pushRemote).not.toHaveBeenCalled();
    expect(response.body.data.pushSkipped).toBe("PROJECT_IS_SHARED");
  });

  it("reports a missing credential rather than failing", async () => {
    githubConnectionFindUnique.mockResolvedValue(null);
    statuses(
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(response.status).toBe(200);
    expect(git.pushRemote).not.toHaveBeenCalled();
    expect(response.body.data.pushSkipped).toBe("NO_CREDENTIAL");
  });

  /** The stored GitHub token must not be spent on a remote that is not GitHub
   *  — the same rule `githubForRemote` enforces for an explicit push. */
  it("will not spend the GitHub connection on a non-GitHub remote", async () => {
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://gitlab.com/a/b.git" },
    ]);
    statuses(
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(git.pushRemote).not.toHaveBeenCalled();
    expect(response.body.data.pushSkipped).toBe("REMOTE_NOT_GITHUB");
  });

  /** A pasted token is a deliberate choice to give a credential to THIS
   *  remote, so it pays for a forge this server knows nothing about. */
  it("uses a supplied token for any remote", async () => {
    git.remotes.mockResolvedValue([
      { name: "origin", url: "https://gitlab.com/a/b.git" },
    ]);
    statuses(
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
      { ahead: 1, behind: 0, changes: [] },
    );

    await sync({ token: "pasted" });

    expect(git.pushRemote).toHaveBeenCalledWith(
      TEST_PROJECT,
      "origin",
      "main",
      "pasted",
    );
    expect(githubToken).not.toHaveBeenCalled();
  });

  it("syncs the only remote when it is not called origin", async () => {
    git.remotes.mockResolvedValue([
      { name: "upstream", url: "https://github.com/a/b.git" },
    ]);
    statuses(
      { ahead: 0, behind: 1, changes: [] },
      { ahead: 0, behind: 1, changes: [] },
      { ahead: 0, behind: 0, changes: [] },
    );

    const response = await sync();

    expect(git.fetchRemote).toHaveBeenCalledWith(TEST_PROJECT, "upstream");
    expect(response.body.data.remote).toBe("upstream");
  });

  it("refuses a project with no remote", async () => {
    git.remotes.mockResolvedValue([]);
    statuses({ ahead: 0, behind: 0, changes: [] });

    const response = await sync();

    expect(response.status).toBe(400);
    expect(git.fetchRemote).not.toHaveBeenCalled();
  });

  it("refuses a branch with no commits", async () => {
    statuses({ unborn: true, branch: undefined, changes: [] });

    const response = await sync();

    expect(response.status).toBe(400);
    expect(git.fetchRemote).not.toHaveBeenCalled();
  });

  it("refuses a project that is not a repository", async () => {
    statuses({ isRepo: false, changes: [] });

    const response = await sync();

    expect(response.status).toBe(400);
    expect(git.fetchRemote).not.toHaveBeenCalled();
  });

  /** Editor, not owner: the fetch-and-pull half is a collaborator's by the
   *  same right `/git/pull` grants it, and the push half checks ownership for
   *  itself. */
  it("asks for editor access", async () => {
    statuses(
      { ahead: 0, behind: 0, changes: [] },
      { ahead: 0, behind: 0, changes: [] },
      { ahead: 0, behind: 0, changes: [] },
    );

    await sync();

    expect(projectAccessService.assertProjectAccess).toHaveBeenCalledWith(
      TEST_PROJECT,
      TEST_USER.sub,
      "editor",
    );
  });

  /** A dirty worktree is the pull service's refusal, not a second copy of the
   *  rule here — so it must surface as the sync failing. */
  it("surfaces a dirty worktree from the pull", async () => {
    statuses(
      { ahead: 0, behind: 1, changes: [{ path: "a.txt" }] },
      { ahead: 0, behind: 1, changes: [{ path: "a.txt" }] },
    );
    git.pullRemote.mockRejectedValue(
      new BadRequestError("Commit or discard your changes before pulling"),
    );

    const response = await sync();

    expect(response.status).toBe(400);
    expect(git.pushRemote).not.toHaveBeenCalled();
  });
});
