import { describe, expect, it } from "vitest";
import {
  parseBranches,
  parseLog,
  parseStatus,
  patchForHunks,
  splitHunks,
} from "./gitService.js";

/** Builds a NUL-terminated porcelain payload the way git actually emits it. */
function porcelain(...entries: string[]): string {
  return entries.map((entry) => `${entry}\0`).join("");
}

describe("parseStatus", () => {
  it("reads the branch out of the header", () => {
    const parsed = parseStatus(porcelain("## main"));
    expect(parsed.branch).toBe("main");
    expect(parsed.changes).toEqual([]);
  });

  it("reads ahead and behind counts", () => {
    const parsed = parseStatus(
      porcelain("## main...origin/main [ahead 2, behind 3]"),
    );
    expect(parsed.branch).toBe("main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
  });

  it("does not invent counts when there is no upstream", () => {
    const parsed = parseStatus(porcelain("## main"));
    expect(parsed.ahead).toBeUndefined();
    expect(parsed.behind).toBeUndefined();
  });

  it("recognises a repository with no commits yet", () => {
    // Before the first commit git reports an unborn branch, and `log` fails.
    const parsed = parseStatus(porcelain("## No commits yet on main"));
    expect(parsed.unborn).toBe(true);
    expect(parsed.branch).toBe("main");
  });

  it("separates the staged column from the unstaged one", () => {
    // "MM" means: modified in the index, and modified again since.
    const parsed = parseStatus(porcelain("## main", "MM src/app.ts"));
    expect(parsed.changes).toEqual([
      { path: "src/app.ts", staged: "modified", unstaged: "modified" },
    ]);
  });

  it("treats a staged addition as having no unstaged half", () => {
    const parsed = parseStatus(porcelain("## main", "A  new.ts"));
    expect(parsed.changes).toEqual([{ path: "new.ts", staged: "added" }]);
  });

  it("reports an unstaged deletion", () => {
    const parsed = parseStatus(porcelain("## main", " D gone.ts"));
    expect(parsed.changes).toEqual([{ path: "gone.ts", unstaged: "deleted" }]);
  });

  it("marks untracked files", () => {
    const parsed = parseStatus(porcelain("## main", "?? notes.md"));
    expect(parsed.changes).toEqual([
      { path: "notes.md", unstaged: "untracked" },
    ]);
  });

  it("pairs a rename with the path it came from", () => {
    // A rename spends two entries: the new path, then the old one.
    const parsed = parseStatus(
      porcelain("## main", "R  new/name.ts", "old/name.ts"),
    );
    expect(parsed.changes).toEqual([
      { path: "new/name.ts", from: "old/name.ts", staged: "renamed" },
    ]);
  });

  it("does not swallow the entry after a rename", () => {
    const parsed = parseStatus(
      porcelain("## main", "R  new.ts", "old.ts", "?? untracked.ts"),
    );
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.changes[1]).toEqual({
      path: "untracked.ts",
      unstaged: "untracked",
    });
  });

  it("keeps paths containing spaces intact", () => {
    // This is the whole reason for -z: without it git would quote this path.
    const parsed = parseStatus(porcelain("## main", "?? my notes file.md"));
    expect(parsed.changes[0]?.path).toBe("my notes file.md");
  });

  it("keeps a path containing a quote intact", () => {
    const parsed = parseStatus(porcelain("## main", '?? od"d.ts'));
    expect(parsed.changes[0]?.path).toBe('od"d.ts');
  });

  it("survives an empty status", () => {
    expect(parseStatus("")).toEqual({ changes: [] });
  });

  it("ignores a detached HEAD rather than calling it a branch", () => {
    const parsed = parseStatus(porcelain("## HEAD (no branch)"));
    expect(parsed.branch).toBeUndefined();
  });

  it("parses output captured from real git", () => {
    // Taken verbatim from `git status --porcelain=v1 -b -z -uall` run inside
    // sandbox-node against a repository with a staged add, an untracked file
    // with spaces in its name, and a file both renamed and then modified.
    // Handwritten fixtures agree with whatever the parser already does; this
    // one does not, which is the point of keeping it.
    const raw =
      "## main\0RM renamed.ts\0tracked.ts\0A  staged.ts\0?? my notes file.md\0";

    expect(parseStatus(raw)).toEqual({
      branch: "main",
      changes: [
        // "RM" is one entry meaning both: renamed in the index, and modified
        // again in the worktree since.
        {
          path: "renamed.ts",
          from: "tracked.ts",
          staged: "renamed",
          unstaged: "modified",
        },
        { path: "staged.ts", staged: "added" },
        { path: "my notes file.md", unstaged: "untracked" },
      ],
    });
  });
});

describe("parseLog", () => {
  const record = (
    hash: string,
    short: string,
    author: string,
    date: string,
    subject: string,
  ) => `${hash}\x1f${short}\x1f${author}\x1f${date}\x1f${subject}\0`;

  it("reads a commit", () => {
    const parsed = parseLog(
      record("abc123def", "abc123d", "Ada", "2026-01-01T00:00:00Z", "First"),
    );
    expect(parsed).toEqual([
      {
        hash: "abc123def",
        shortHash: "abc123d",
        author: "Ada",
        date: "2026-01-01T00:00:00Z",
        subject: "First",
      },
    ]);
  });

  it("reads several commits", () => {
    const parsed = parseLog(
      record("h1", "s1", "Ada", "2026-01-02T00:00:00Z", "Second") +
        record("h2", "s2", "Bob", "2026-01-01T00:00:00Z", "First"),
    );
    expect(parsed.map((commit) => commit.subject)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("keeps a subject that itself contains the field separator", () => {
    // The subject is joined back from whatever is left, so a stray separator
    // cannot shift the fields parsed before it.
    const parsed = parseLog(
      record("h", "s", "Ada", "2026-01-01T00:00:00Z", "we\x1fird"),
    );
    expect(parsed[0]?.author).toBe("Ada");
    expect(parsed[0]?.subject).toBe("we\x1fird");
  });

  it("returns nothing for empty output", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseBranches", () => {
  /** Builds what `git branch --format=%(refname:short)%00%(HEAD)` emits. */
  function listing(...entries: [string, boolean][]): string {
    return entries.map(([name, current]) => `${name}\0${current ? "*" : " "}`).join("\n");
  }

  it("reads names and marks the current branch", () => {
    const branches = parseBranches(listing(["main", true], ["feature", false]));
    expect(branches).toEqual([
      { name: "main", current: true },
      { name: "feature", current: false },
    ]);
  });

  it("returns nothing for an empty listing", () => {
    expect(parseBranches("")).toEqual([]);
  });

  it("keeps a name containing a space", () => {
    // git allows it, so splitting on whitespace would corrupt the name.
    const branches = parseBranches(listing(["feat/two words", false]));
    expect(branches[0]?.name).toBe("feat/two words");
  });

  it("keeps slashes and dots in a name", () => {
    const branches = parseBranches(listing(["release/1.2.x", false]));
    expect(branches[0]?.name).toBe("release/1.2.x");
  });

  it("skips a detached HEAD, which is a state rather than a branch", () => {
    const branches = parseBranches(listing(["(HEAD detached at abc1234)", true]));
    expect(branches).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(parseBranches("\n\n")).toEqual([]);
  });

  it("marks nothing current when none is", () => {
    const branches = parseBranches(listing(["main", false]));
    expect(branches[0]?.current).toBe(false);
  });
});

const TWO_HUNKS = `diff --git a/f.txt b/f.txt
index 8afd661..60fd8f7 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
-l1
+CHANGED1
 l2
 l3
 l4
@@ -12,4 +12,4 @@ l11
 l12
 l13
 l14
-l15
+CHANGED15
`;

describe("splitHunks", () => {
  it("separates the header from the hunks", () => {
    const { header, hunks } = splitHunks(TWO_HUNKS);

    expect(header).toContain("diff --git a/f.txt b/f.txt");
    expect(header).toContain("+++ b/f.txt");
    expect(header).not.toContain("@@");
    expect(hunks).toHaveLength(2);
  });

  it("starts each hunk at its own @@ line", () => {
    const { hunks } = splitHunks(TWO_HUNKS);

    expect(hunks[0]?.startsWith("@@ -1,4 +1,4 @@")).toBe(true);
    expect(hunks[1]?.startsWith("@@ -12,4 +12,4 @@")).toBe(true);
  });

  it("keeps a hunk's bytes exactly, so the patch still applies", () => {
    const { hunks } = splitHunks(TWO_HUNKS);

    // Context lines keep their leading space; nothing is trimmed.
    expect(hunks[0]).toContain("\n l2\n");
    expect(hunks[0]).toContain("-l1\n");
    expect(hunks[0]).toContain("+CHANGED1\n");
  });

  it("finds no hunks in a patch that has none", () => {
    expect(splitHunks("").hunks).toEqual([]);
    expect(splitHunks("Binary files differ\n").hunks).toEqual([]);
  });

  it("does not mistake a removed line beginning @@ for a hunk header", () => {
    // A hunk header is matched at the start of a line; a removed line starts
    // with the marker, so "-@@" is content.
    const { hunks } = splitHunks(`--- a/f
+++ b/f
@@ -1 +1 @@
-@@ not a header
+ok
`);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toContain("-@@ not a header");
  });
});

describe("patchForHunks", () => {
  it("keeps the header in front of the chosen hunk", () => {
    const patch = patchForHunks(TWO_HUNKS, [0]);

    expect(patch).toContain("--- a/f.txt");
    expect(patch).toContain("+CHANGED1");
    expect(patch).not.toContain("CHANGED15");
  });

  it("takes the second hunk alone", () => {
    const patch = patchForHunks(TWO_HUNKS, [1]);

    expect(patch).toContain("+CHANGED15");
    expect(patch).not.toContain("+CHANGED1\n");
  });

  it("takes several, in file order whatever order they were asked for", () => {
    const patch = patchForHunks(TWO_HUNKS, [1, 0]);

    expect(patch.indexOf("CHANGED1")).toBeLessThan(patch.indexOf("CHANGED15"));
  });

  it("ignores a repeated index rather than duplicating the hunk", () => {
    const patch = patchForHunks(TWO_HUNKS, [0, 0, 0]);

    expect(patch.split("+CHANGED1\n")).toHaveLength(2);
  });

  it("ignores an index past the end", () => {
    expect(patchForHunks(TWO_HUNKS, [9])).toBe("");
    expect(patchForHunks(TWO_HUNKS, [0, 9])).toContain("+CHANGED1");
  });

  it("returns nothing when asked for nothing", () => {
    expect(patchForHunks(TWO_HUNKS, [])).toBe("");
  });

  it("returns nothing for a patch with no hunks", () => {
    expect(patchForHunks("", [0])).toBe("");
  });
});
