import { beforeEach, describe, expect, it, vi } from "vitest";

/** The rest of git. plan.md §10.13.
 *
 *  Every one of these runs `git` inside the project's container, so the seam
 *  under test is the argv this builds and the output it parses. The container
 *  and the exec are the parts a Docker daemon would exercise and this
 *  environment has none; what IS testable here is every decision the code
 *  makes, and those are where the bugs live.
 */
const exec = vi.hoisted(() => vi.fn());
vi.mock("../containers/execCapture.js", () => ({ execCapture: exec }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn().mockResolvedValue({}),
  MOUNT_POINT: "/home/sandbox/app",
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

import {
  showFileAtRef,
  amendCommit,
  blame,
  compareRefs,
  createTag,
  revertCommit,
  stashApply,
  stashPush,
  stashes,
  tags,
} from "./gitService.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The argv of the nth `git` call. */
function argv(call = 0): string[] {
  return (exec.mock.calls[call]?.[1] as string[]).slice(1);
}

function ok(stdout = "") {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr = "bad") {
  return { stdout: "", stderr, exitCode: 1 };
}

beforeEach(() => {
  exec.mockReset();
  // `isRepo` runs first in most of these.
  exec.mockResolvedValue(ok("true\n"));
});

describe("stash", () => {
  it("parses the branch out of the subject", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(
        ok("stash@{0}\x1fWIP on main: 1234abc a message\x1f2026-09-10T00:00:00Z\0"),
      );

    // The branch is most of how somebody tells two stashes apart, so it is
    // parsed rather than shown raw.
    await expect(stashes(PROJECT)).resolves.toEqual([
      {
        ref: "stash@{0}",
        index: 0,
        branch: "main",
        message: "1234abc a message",
        at: "2026-09-10T00:00:00Z",
      },
    ]);
  });

  it("parses the 'On branch' form as well as 'WIP on'", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(ok("stash@{0}\x1fOn feature: saved\x1f2026-09-10T00:00:00Z\0"));

    const list = await stashes(PROJECT);
    expect(list[0]?.branch).toBe("feature");
    expect(list[0]?.message).toBe("saved");
  });

  it("is empty for a project that is not a repository", async () => {
    exec.mockResolvedValue(fail("not a git repository"));
    await expect(stashes(PROJECT)).resolves.toEqual([]);
  });

  it("passes a message as one argument, so a leading dash is not a flag", async () => {
    exec.mockResolvedValue(ok());
    await stashPush(PROJECT, "--force is not a flag here", false);

    const args = argv();
    expect(args).toContain("--message=--force is not a flag here");
    // Never as two entries: `["--message", "--force"]` would have git read the
    // second as its own option.
    expect(args).not.toContain("--message");
  });

  it("includes untracked files only when asked", async () => {
    exec.mockResolvedValue(ok());
    await stashPush(PROJECT, "", true);
    expect(argv()).toContain("--include-untracked");

    exec.mockClear();
    await stashPush(PROJECT, "", false);
    expect(argv()).not.toContain("--include-untracked");
  });

  it("addresses a stash by index, not by a string the client sent", async () => {
    exec.mockResolvedValue(ok());
    await stashApply(PROJECT, 2, false);
    expect(argv()).toEqual(["stash", "apply", "stash@{2}"]);
  });

  it("pops when the caller does not want to keep it", async () => {
    exec.mockResolvedValue(ok());
    await stashApply(PROJECT, 0, true);
    expect(argv()).toEqual(["stash", "pop", "stash@{0}"]);
  });

  it("refuses an index that is not one", async () => {
    await expect(stashApply(PROJECT, -1, false)).rejects.toThrow(/not a stash/);
    await expect(stashApply(PROJECT, 1.5, false)).rejects.toThrow(/not a stash/);
  });
});

describe("blame", () => {
  const porcelain = [
    "1111111111111111111111111111111111111111 1 1 2",
    "author Ada",
    "author-time 1757462400",
    "summary first commit",
    "\tconst x = 1;",
    "1111111111111111111111111111111111111111 2 2",
    "author Ada",
    "author-time 1757462400",
    "summary first commit",
    "\tconst y = 2;",
  ].join("\n");

  it("attributes each line", async () => {
    exec.mockResolvedValueOnce(ok("true\n")).mockResolvedValueOnce(ok(porcelain));

    const lines = await blame(PROJECT, "src/index.ts");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      line: 1,
      shortSha: "1111111",
      author: "Ada",
      summary: "first commit",
    });
  });

  it("turns git's unix time into an ISO date", async () => {
    exec.mockResolvedValueOnce(ok("true\n")).mockResolvedValueOnce(ok(porcelain));
    const lines = await blame(PROJECT, "src/index.ts");
    expect(lines[0]?.at).toBe(new Date(1757462400 * 1000).toISOString());
  });

  it("is empty for a file with no history rather than an error", async () => {
    // An untracked file, or a repository with no commits. There is simply
    // nothing to attribute.
    exec.mockResolvedValueOnce(ok("true\n")).mockResolvedValueOnce(fail("no such path"));
    await expect(blame(PROJECT, "new.ts")).resolves.toEqual([]);
  });

  it("refuses a path that begins with a dash", async () => {
    // git reads a leading dash as a flag, and this ends up as an argv entry.
    await expect(blame(PROJECT, "--help")).rejects.toThrow(/not a path/);
  });

  it("refuses a path that climbs out of the project", async () => {
    await expect(blame(PROJECT, "../../etc/passwd")).rejects.toThrow(/not a path/);
  });

  it("passes the path after --, so a file named like a ref is still a file", async () => {
    exec.mockResolvedValueOnce(ok("true\n")).mockResolvedValueOnce(ok(porcelain));
    await blame(PROJECT, "main");
    expect(argv(1)).toEqual(["blame", "--line-porcelain", "--", "main"]);
  });
});

describe("amend", () => {
  it("refuses when the commit is already pushed", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n")) // isRepo
      .mockResolvedValueOnce(ok("abc\n")) // rev-parse HEAD
      .mockResolvedValueOnce(ok("")); // merge-base --is-ancestor: exit 0

    // The difference between a convenience and a way to lose somebody else's
    // work.
    await expect(amendCommit(PROJECT, "new message")).rejects.toThrow(
      /already pushed/,
    );
  });

  it("allows it when there is no upstream at all", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(ok("abc\n"))
      // Non-zero covers both "not pushed" and "no upstream configured", and
      // both are fine to amend.
      .mockResolvedValueOnce(fail("no upstream configured"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(ok(""));

    await expect(amendCommit(PROJECT, "new message")).resolves.toEqual([]);
  });

  it("refuses when there is no commit yet", async () => {
    exec.mockResolvedValueOnce(ok("true\n")).mockResolvedValueOnce(fail("unknown revision"));
    await expect(amendCommit(PROJECT, "m")).rejects.toThrow(/no commit to amend/);
  });

  it("refuses an empty message", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(ok("abc\n"))
      .mockResolvedValueOnce(fail("no upstream"));
    await expect(amendCommit(PROJECT, "   ")).rejects.toThrow(/needs a message/);
  });
});

describe("revert and cherry-pick", () => {
  it("commits the revert rather than leaving it staged", async () => {
    exec.mockResolvedValue(ok());
    await revertCommit(PROJECT, "abc1234");

    // A revert left staged looks, in the status panel, exactly like somebody's
    // own uncommitted work.
    expect(argv()).toEqual(["revert", "--no-edit", "abc1234"]);
  });

  it("refuses anything that is not a commit id", async () => {
    for (const bad of ["--hard", "HEAD~1; rm -rf /", "$(whoami)", "main"]) {
      await expect(revertCommit(PROJECT, bad)).rejects.toThrow(/not a commit id/);
    }
  });
});

describe("tags", () => {
  it("tells an annotated tag from a lightweight one", async () => {
    exec
      .mockResolvedValueOnce(ok("true\n"))
      .mockResolvedValueOnce(
        ok("v1.0\x1fabc\x1ftag\x1frelease one\0v0.9\x1fdef\x1fcommit\x1f\0"),
      );

    // One is a record, the other a bookmark.
    const list = await tags(PROJECT);
    expect(list[0]).toMatchObject({ name: "v1.0", annotated: true, message: "release one" });
    expect(list[1]).toMatchObject({ name: "v0.9", annotated: false, message: "" });
  });

  it("makes an annotated tag when given a message", async () => {
    exec.mockResolvedValue(ok());
    await createTag(PROJECT, "v1.0", "the first one");

    const args = argv(1);
    expect(args).toContain("--annotate");
    expect(args).toContain("--message=the first one");
  });

  it("makes a lightweight tag when not", async () => {
    exec.mockResolvedValue(ok());
    await createTag(PROJECT, "v1.0", "");
    expect(argv(1)).toEqual(["tag", "v1.0"]);
  });
});

describe("comparing two refs", () => {
  it("answers all three questions at once", async () => {
    exec
      // The two `check-ref-format` calls `assertValidBranchName` makes first --
      // a ref name is an argv entry, and this file validates every one of them
      // through git itself rather than reimplementing its rules.
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("h1\x1fh1\x1fAda\x1f2026-09-10T00:00:00Z\x1fahead\0"))
      .mockResolvedValueOnce(ok("h2\x1fh2\x1fAda\x1f2026-09-10T00:00:00Z\x1fbehind\0"))
      .mockResolvedValueOnce(ok("3\t1\tsrc/a.ts\n-\t-\timg.png\n"));

    const comparison = await compareRefs(PROJECT, "main", "feature");
    expect(comparison.ahead[0]?.subject).toBe("ahead");
    expect(comparison.behind[0]?.subject).toBe("behind");
    expect(comparison.files[0]).toEqual({ path: "src/a.ts", added: 3, removed: 1 });
  });

  it("shows a binary file as zero rather than NaN", async () => {
    exec
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("-\t-\timg.png\n"));

    const comparison = await compareRefs(PROJECT, "main", "feature");
    expect(comparison.files[0]).toEqual({ path: "img.png", added: 0, removed: 0 });
  });

  it("refuses a ref that does not exist rather than saying they match", async () => {
    exec
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail("unknown revision nope"))
      .mockResolvedValueOnce(fail("unknown revision nope"))
      .mockResolvedValueOnce(ok(""));

    // An empty comparison would read as "these are the same".
    await expect(compareRefs(PROJECT, "main", "nope")).rejects.toThrow();
  });
});

describe("one file as it stands on another ref", () => {
  it("reads it with ref:path as a single argument", async () => {
    exec
      .mockResolvedValueOnce(ok()) // check-ref-format
      .mockResolvedValueOnce(ok("export const x = 1;\n"));

    await expect(showFileAtRef(PROJECT, "main", "src/a.ts")).resolves.toBe(
      "export const x = 1;\n",
    );
    expect(argv(1)).toEqual(["show", "main:src/a.ts"]);
  });

  it("is null for a file that does not exist on that ref", async () => {
    exec.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail("path does not exist"));

    // "This file is new on your branch" is an ANSWER: the diff is against
    // nothing and every line is an addition. An error would make a legitimate
    // comparison look like a failure.
    await expect(showFileAtRef(PROJECT, "main", "new.ts")).resolves.toBeNull();
  });

  it("refuses a ref that could be read as a flag", async () => {
    await expect(showFileAtRef(PROJECT, "--upload-pack=x", "a.ts")).rejects.toThrow(
      /not a usable branch name/,
    );
  });

  it("refuses a path that climbs out of the project", async () => {
    exec.mockResolvedValueOnce(ok());
    await expect(showFileAtRef(PROJECT, "main", "../../etc/passwd")).rejects.toThrow(
      /not a path/,
    );
  });
});
