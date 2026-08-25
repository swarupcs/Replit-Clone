import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./parseUnifiedDiff.ts";

const SIMPLE = `diff --git a/src/App.tsx b/src/App.tsx
index 1234567..89abcde 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,4 +1,5 @@
 import React from "react";
-const greeting = "hi";
+const greeting = "hello";
+const extra = 1;
 export default App;
`;

describe("parseUnifiedDiff", () => {
  it("returns nothing for an empty patch", () => {
    const parsed = parseUnifiedDiff("");
    expect(parsed.hunks).toEqual([]);
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
    expect(parsed.binary).toBe(false);
  });

  it("drops the header noise before the first hunk", () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    expect(parsed.hunks).toHaveLength(1);
    // Nothing from `diff --git`, `index`, `---` or `+++` survives.
    const texts = parsed.hunks[0]!.lines.map((line) => line.text);
    expect(texts.some((text) => text.startsWith("diff --git"))).toBe(false);
    expect(texts.some((text) => text.startsWith("++ b/"))).toBe(false);
  });

  it("keeps the hunk header verbatim", () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    expect(parsed.hunks[0]!.header).toBe("@@ -1,4 +1,5 @@");
  });

  it("counts additions and deletions", () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
  });

  it("numbers both files, skipping the side a line is absent from", () => {
    const [hunk] = parseUnifiedDiff(SIMPLE).hunks;
    const lines = hunk!.lines;

    // Context line 1 exists in both files.
    expect(lines[0]).toMatchObject({ kind: "context", oldLine: 1, newLine: 1 });
    // The removal has an old number and no new one.
    expect(lines[1]).toMatchObject({ kind: "remove", oldLine: 2 });
    expect(lines[1]!.newLine).toBeUndefined();
    // The additions have new numbers and no old one.
    expect(lines[2]).toMatchObject({ kind: "add", newLine: 2 });
    expect(lines[2]!.oldLine).toBeUndefined();
    expect(lines[3]).toMatchObject({ kind: "add", newLine: 3 });
    // Context after the change resumes on both sides.
    expect(lines[4]).toMatchObject({ kind: "context", oldLine: 3, newLine: 4 });
  });

  it("reads several hunks, each restarting at its own offsets", () => {
    const parsed = parseUnifiedDiff(`@@ -1,2 +1,2 @@
 one
-two
+TWO
@@ -40,2 +40,2 @@
 forty
-forty-one
+FORTY-ONE
`);

    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1]!.lines[0]).toMatchObject({
      kind: "context",
      oldLine: 40,
      newLine: 40,
    });
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(2);
  });

  it("handles a hunk header with no line counts", () => {
    const parsed = parseUnifiedDiff(`@@ -1 +1 @@
-before
+after
`);
    expect(parsed.hunks[0]!.lines[0]).toMatchObject({
      kind: "remove",
      oldLine: 1,
    });
    expect(parsed.hunks[0]!.lines[1]).toMatchObject({ kind: "add", newLine: 1 });
  });

  it("treats an empty context line as context, advancing both sides", () => {
    // git writes an unchanged blank line as a bare newline, with no leading
    // space for the marker.
    const parsed = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 first

-old
+new
`);
    const lines = parsed.hunks[0]!.lines;
    expect(lines[1]).toMatchObject({ kind: "context", oldLine: 2, newLine: 2 });
    expect(lines[2]).toMatchObject({ kind: "remove", oldLine: 3 });
  });

  it("keeps a no-newline marker as meta, uncounted", () => {
    const parsed = parseUnifiedDiff(`@@ -1 +1 @@
-old
\\ No newline at end of file
+new
`);
    const meta = parsed.hunks[0]!.lines.find((line) => line.kind === "meta");
    expect(meta?.text).toBe("No newline at end of file");
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
  });

  it("flags a binary file and shows no hunks", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });

  it("reads an untracked file, which git diffs against /dev/null", () => {
    const parsed = parseUnifiedDiff(`diff --git a/dev/null b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+first
+second
`);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(0);
    expect(parsed.hunks[0]!.lines[0]).toMatchObject({
      kind: "add",
      newLine: 1,
    });
  });

  it("reads a deletion, where every line goes", () => {
    const parsed = parseUnifiedDiff(`@@ -1,2 +0,0 @@
-gone
-also gone
`);
    expect(parsed.deletions).toBe(2);
    expect(parsed.additions).toBe(0);
  });

  it("does not mistake a removed line starting with -- for a header", () => {
    const parsed = parseUnifiedDiff(`@@ -1,1 +1,1 @@
--- not a header, just SQL
+-- still not
`);
    expect(parsed.deletions).toBe(1);
    expect(parsed.additions).toBe(1);
    expect(parsed.hunks[0]!.lines[0]!.text).toBe("-- not a header, just SQL");
  });
});
