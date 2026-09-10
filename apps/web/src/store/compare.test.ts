// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { describeCompare, useCompareStore } from "./compareStore.ts";

beforeEach(() => {
  useCompareStore.getState().reset();
});

describe("what the diff pane compares against", () => {
  it("starts at the saved copy, which is the behaviour that already existed", () => {
    expect(useCompareStore.getState().against).toEqual({ kind: "saved" });
    // Nothing fetched: the editor already holds the saved copy, which is
    // exactly why this is the default.
    expect(useCompareStore.getState().left).toBeNull();
  });

  it("drops the old text as the source changes, not when the new one arrives", () => {
    useCompareStore.getState().setLeft("old file", false);
    useCompareStore.getState().setAgainst({ kind: "ref", ref: "main" });

    // Showing the previous comparison's left side against this file would be a
    // diff of two unrelated things, briefly -- and briefly is enough to be
    // believed.
    expect(useCompareStore.getState().left).toBeNull();
  });

  it("remembers that the other side does not exist", () => {
    // A file new on this branch. Shown rather than hidden: an empty left pane
    // with no explanation reads as a failure to load.
    useCompareStore.getState().setLeft("", true);
    expect(useCompareStore.getState().missing).toBe(true);
  });

  it("clears missing when a new source is chosen", () => {
    useCompareStore.getState().setLeft("", true);
    useCompareStore.getState().setAgainst({ kind: "file", relPath: "a.ts" });
    expect(useCompareStore.getState().missing).toBe(false);
  });

  it("names each source in the words the pane shows", () => {
    expect(describeCompare({ kind: "saved" })).toBe("the saved file");
    expect(describeCompare({ kind: "ref", ref: "main" })).toBe("main");
    expect(describeCompare({ kind: "file", relPath: "src/a.ts" })).toBe("src/a.ts");
  });

  it("goes back to the saved copy on reset", () => {
    useCompareStore.getState().setAgainst({ kind: "ref", ref: "main" });
    useCompareStore.getState().setLeft("x", false);
    useCompareStore.getState().reset();

    expect(useCompareStore.getState().against).toEqual({ kind: "saved" });
    expect(useCompareStore.getState().left).toBeNull();
  });
});
