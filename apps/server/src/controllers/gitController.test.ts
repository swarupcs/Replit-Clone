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
}));
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("../service/projectAccessService.js", () => projectAccessService);
vi.mock("../service/gitService.js", () => git);
vi.mock("../lib/prisma.js", () => ({ prisma: { user: { findUnique } } }));

import {
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
]);

const STATUS = { branch: "main", staged: [], unstaged: [] };

beforeEach(() => {
  vi.clearAllMocks();
  projectAccessService.assertProjectAccess.mockResolvedValue({ id: TEST_PROJECT });
  git.status.mockResolvedValue(STATUS);
  findUnique.mockResolvedValue({ email: TEST_USER.email });
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
