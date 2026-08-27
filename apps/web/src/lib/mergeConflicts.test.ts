import { describe, expect, it } from "vitest";
import {
  findConflicts,
  hasConflicts,
  resolveConflict,
} from "./mergeConflicts.ts";

const conflicted = [
  "before",
  "<<<<<<< HEAD",
  "ours one",
  "ours two",
  "=======",
  "theirs one",
  ">>>>>>> feature/x",
  "after",
].join("\n");

describe("findConflicts", () => {
  it("finds a block and both sides", () => {
    const [block] = findConflicts(conflicted);
    expect(block).toMatchObject({
      startLine: 2,
      separatorLine: 5,
      endLine: 7,
      currentLabel: "HEAD",
      incomingLabel: "feature/x",
      currentLines: ["ours one", "ours two"],
      incomingLines: ["theirs one"],
    });
  });

  it("finds several blocks in one file", () => {
    const text = [conflicted, conflicted].join("\n");
    expect(findConflicts(text)).toHaveLength(2);
  });

  it("says nothing about a clean file", () => {
    expect(findConflicts("just\nsome\nlines")).toEqual([]);
  });

  /** Markers turn up in a README explaining how to resolve conflicts, and in
   *  string literals. A scanner that only accepts a complete, ordered
   *  sequence rejects those rather than pairing a real marker with a
   *  decorative one. */
  it("ignores a start with no separator and no end", () => {
    expect(findConflicts("<<<<<<< HEAD\njust text\nmore text")).toEqual([]);
  });

  it("ignores an end with no start", () => {
    expect(findConflicts("text\n>>>>>>> other")).toEqual([]);
  });

  it("ignores a separator on its own", () => {
    expect(findConflicts("text\n=======\nmore")).toEqual([]);
  });

  it("falls back to readable labels when git wrote none", () => {
    const [block] = findConflicts("<<<<<<<\na\n=======\nb\n>>>>>>>");
    expect(block?.currentLabel).toBe("Current");
    expect(block?.incomingLabel).toBe("Incoming");
  });

  it("handles an empty side", () => {
    const [block] = findConflicts("<<<<<<< HEAD\n=======\nb\n>>>>>>> x");
    expect(block?.currentLines).toEqual([]);
    expect(block?.incomingLines).toEqual(["b"]);
  });
});

describe("resolveConflict", () => {
  const [block] = findConflicts(conflicted);

  it("keeps the current side", () => {
    expect(resolveConflict(conflicted, block!, "current")).toBe(
      "before\nours one\nours two\nafter",
    );
  });

  it("keeps the incoming side", () => {
    expect(resolveConflict(conflicted, block!, "incoming")).toBe(
      "before\ntheirs one\nafter",
    );
  });

  it("keeps both, current first", () => {
    expect(resolveConflict(conflicted, block!, "both")).toBe(
      "before\nours one\nours two\ntheirs one\nafter",
    );
  });

  /** The whole point: no markers left behind. A half-resolved file that
   *  still parses is worse than one that obviously does not. */
  it("leaves no markers behind", () => {
    for (const resolution of ["current", "incoming", "both"] as const) {
      expect(hasConflicts(resolveConflict(conflicted, block!, resolution))).toBe(
        false,
      );
    }
  });

  it("resolves one block without disturbing another", () => {
    const two = [conflicted, conflicted].join("\n");
    const [first] = findConflicts(two);
    const resolved = resolveConflict(two, first!, "current");

    expect(findConflicts(resolved)).toHaveLength(1);
    expect(resolved).toContain("theirs one");
  });

  /** Resolving the second block first must not shift the first one's line
   *  numbers out from under it — which it does not, because each resolve
   *  works from a fresh scan of the text it was handed. */
  it("is safe to resolve blocks in any order", () => {
    const two = [conflicted, conflicted].join("\n");
    const blocks = findConflicts(two);
    const afterSecond = resolveConflict(two, blocks[1]!, "incoming");
    const remaining = findConflicts(afterSecond);
    const done = resolveConflict(afterSecond, remaining[0]!, "current");

    expect(hasConflicts(done)).toBe(false);
    expect(done).toBe("before\nours one\nours two\nafter\nbefore\ntheirs one\nafter");
  });
});
