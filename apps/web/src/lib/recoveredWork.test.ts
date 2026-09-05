import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecovered,
  forgetBuffer,
  recoveredBuffers,
  rememberBuffer,
} from "./recoveredWork.ts";

/** Edits kept across a session that ended badly.
 *
 *  Most of this file is about the ways storage misbehaves, and that is the
 *  point: this record is read on load, in the path that opens the IDE, from a
 *  store that is shared with other tabs, survives deploys, and can be edited by
 *  hand. Anything it throws takes the editor down with it — which is the
 *  failure `useWorkspaceSession` already learned about the hard way, quoted in
 *  its own comment: "one unreadable value in localStorage and the IDE would not
 *  open at all".
 */

beforeEach(() => {
  localStorage.clear();
});

describe("keeping and returning buffers", () => {
  it("returns nothing for a project with no record", () => {
    expect(recoveredBuffers("p1")).toEqual([]);
  });

  it("keeps a buffer per path", () => {
    rememberBuffer("p1", "a.ts", "one");
    rememberBuffer("p1", "b.ts", "two");

    expect(recoveredBuffers("p1").map((entry) => entry.relPath).sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("replaces a path's buffer rather than accumulating", () => {
    rememberBuffer("p1", "a.ts", "one");
    rememberBuffer("p1", "a.ts", "two");

    expect(recoveredBuffers("p1")).toHaveLength(1);
    expect(recoveredBuffers("p1")[0]?.data).toBe("two");
  });

  /** Two projects open in two tabs must not offer each other's work back. */
  it("keeps projects apart", () => {
    rememberBuffer("p1", "a.ts", "one");
    rememberBuffer("p2", "a.ts", "two");

    expect(recoveredBuffers("p1")[0]?.data).toBe("one");
    expect(recoveredBuffers("p2")[0]?.data).toBe("two");
  });

  it("forgets one path without touching the others", () => {
    rememberBuffer("p1", "a.ts", "one");
    rememberBuffer("p1", "b.ts", "two");

    forgetBuffer("p1", "a.ts");

    expect(recoveredBuffers("p1").map((entry) => entry.relPath)).toEqual([
      "b.ts",
    ]);
  });

  it("clears a whole project", () => {
    rememberBuffer("p1", "a.ts", "one");
    clearRecovered("p1");

    expect(recoveredBuffers("p1")).toEqual([]);
    // And leaves no empty key behind for the next read to parse.
    expect(localStorage.getItem("rc.recovered.p1")).toBeNull();
  });

  /** Newest first, because the file somebody was in the middle of is the one
   *  they will look for. */
  it("returns the most recent first", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T10:00:00Z"));
      rememberBuffer("p1", "old.ts", "one");
      vi.setSystemTime(new Date("2026-09-05T10:05:00Z"));
      rememberBuffer("p1", "new.ts", "two");

      expect(recoveredBuffers("p1").map((entry) => entry.relPath)).toEqual([
        "new.ts",
        "old.ts",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the size caps", () => {
  /** Skipped rather than truncated. Half a file restored as though it were
   *  whole is worse than no offer at all — it looks like the work, and it is
   *  not. */
  it("does not keep a file larger than the per-file cap", () => {
    rememberBuffer("p1", "huge.ts", "x".repeat(256 * 1024 + 1));

    expect(recoveredBuffers("p1")).toEqual([]);
  });

  it("keeps one exactly at the cap", () => {
    rememberBuffer("p1", "big.ts", "x".repeat(256 * 1024));

    expect(recoveredBuffers("p1")).toHaveLength(1);
  });

  /** A file that has grown past the cap must lose its stale smaller record
   *  too, or the offer would hand back a version from before it grew. */
  it("drops an existing record when the file grows past the cap", () => {
    rememberBuffer("p1", "a.ts", "small");
    rememberBuffer("p1", "a.ts", "x".repeat(256 * 1024 + 1));

    expect(recoveredBuffers("p1")).toEqual([]);
  });

  /** localStorage is a few megabytes for the whole origin, and the workspace
   *  session and theme live there too. Oldest goes first, because the newest
   *  is what somebody was in the middle of. */
  it("drops the oldest when a project exceeds its budget", () => {
    vi.useFakeTimers();
    try {
      const chunk = "x".repeat(200 * 1024);
      for (let index = 0; index < 8; index += 1) {
        vi.setSystemTime(new Date(2026, 8, 5, 10, index));
        rememberBuffer("p1", `file${String(index)}.ts`, chunk);
      }

      const kept = recoveredBuffers("p1").map((entry) => entry.relPath);
      expect(kept.length).toBeLessThan(8);
      // The most recent survives; the first does not.
      expect(kept).toContain("file7.ts");
      expect(kept).not.toContain("file0.ts");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when storage misbehaves", () => {
  /** Read on load, in the path that opens the IDE. */
  it("returns nothing rather than throwing on unparseable storage", () => {
    localStorage.setItem("rc.recovered.p1", "{not json");

    expect(() => recoveredBuffers("p1")).not.toThrow();
    expect(recoveredBuffers("p1")).toEqual([]);
  });

  it("ignores a value of the wrong shape", () => {
    localStorage.setItem("rc.recovered.p1", JSON.stringify({ a: 1 }));

    expect(recoveredBuffers("p1")).toEqual([]);
  });

  /** One bad entry must not cost the others. */
  it("keeps the entries that are well formed and drops the rest", () => {
    localStorage.setItem(
      "rc.recovered.p1",
      JSON.stringify([
        { relPath: "good.ts", data: "one", savedAt: 1 },
        { relPath: "bad.ts", data: 42 },
        null,
        "nonsense",
      ]),
    );

    expect(recoveredBuffers("p1").map((entry) => entry.relPath)).toEqual([
      "good.ts",
    ]);
  });

  /** A full quota must not break typing: the buffer is still in memory and
   *  still marked unsaved. What is lost is the ability to recover it after a
   *  crash, which is strictly better than refusing the keystroke. */
  it("swallows a write that storage refuses", () => {
    // Spied on the instance rather than on `Storage.prototype`: this suite
    // runs in the node environment, where `localStorage` exists but the
    // `Storage` constructor does not.
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    try {
      expect(() => rememberBuffer("p1", "a.ts", "one")).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});
