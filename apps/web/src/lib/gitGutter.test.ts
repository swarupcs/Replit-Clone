import { describe, expect, it } from "vitest";
import { gutterRegions } from "./gitGutter.ts";

const patch = (body: string) => `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${body}`;

describe("gutterRegions", () => {
  it("marks a run of added lines", () => {
    expect(
      gutterRegions(patch("@@ -1,2 +1,4 @@\n a\n+b\n+c\n d\n")),
    ).toEqual([{ kind: "added", startLine: 2, endLine: 3 }]);
  });

  /** Additions and removals in one run are the same edit seen from two
   *  sides, so they collapse rather than reading as one of each. */
  it("reads a replaced line as modified, not as an add and a remove", () => {
    expect(
      gutterRegions(patch("@@ -1,3 +1,3 @@\n a\n-old\n+new\n c\n")),
    ).toEqual([{ kind: "modified", startLine: 2, endLine: 2 }]);
  });

  /** A deletion has no line in the current file to draw a bar over, so it
   *  gets a marker at the seam instead. */
  it("puts a deletion marker on the line above the gap", () => {
    expect(
      gutterRegions(patch("@@ -1,3 +1,2 @@\n a\n-gone\n b\n")),
    ).toEqual([{ kind: "removed", startLine: 1, endLine: 1 }]);
  });

  it("clamps a deletion at the top of the file to line 1", () => {
    expect(
      gutterRegions(patch("@@ -1,2 +1,1 @@\n-gone\n a\n")),
    ).toEqual([{ kind: "removed", startLine: 1, endLine: 1 }]);
  });

  it("separates runs split by a context line", () => {
    expect(
      gutterRegions(patch("@@ -1,4 +1,5 @@\n a\n+one\n b\n+two\n c\n")),
    ).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 4, endLine: 4 },
    ]);
  });

  it("handles several hunks", () => {
    expect(
      gutterRegions(
        patch("@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10,2 +11,3 @@\n x\n+y\n z\n"),
      ),
    ).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 12, endLine: 12 },
    ]);
  });

  it("reads a replaced block as one modification", () => {
    expect(
      gutterRegions(patch("@@ -1,4 +1,4 @@\n a\n-x\n-y\n+p\n+q\n d\n")),
    ).toEqual([{ kind: "modified", startLine: 2, endLine: 3 }]);
  });

  /** An unequal replacement is still one edit: three lines became one. */
  it("reads an unequal replacement as one modification", () => {
    expect(
      gutterRegions(patch("@@ -1,5 +1,3 @@\n a\n-x\n-y\n-z\n+p\n e\n")),
    ).toEqual([{ kind: "modified", startLine: 2, endLine: 2 }]);
  });

  it("ignores a no-newline marker rather than counting it as a change", () => {
    expect(
      gutterRegions(patch("@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file\n")),
    ).toEqual([{ kind: "modified", startLine: 1, endLine: 1 }]);
  });

  it("says nothing about a binary file", () => {
    expect(gutterRegions("Binary files a/x.png and b/x.png differ\n")).toEqual([]);
  });

  it("says nothing about an empty patch", () => {
    expect(gutterRegions("")).toEqual([]);
  });

  it("marks a wholly new file as added", () => {
    expect(
      gutterRegions(patch("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n")),
    ).toEqual([{ kind: "added", startLine: 1, endLine: 3 }]);
  });
});
