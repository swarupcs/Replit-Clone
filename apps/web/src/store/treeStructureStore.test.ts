import { beforeEach, describe, expect, it } from "vitest";
import { useTreeStructureStore } from "./treeStructureStore.ts";

const store = () => useTreeStructureStore.getState();

beforeEach(() => {
  useTreeStructureStore.setState({ expandedPaths: new Set<string>() });
});

describe("revealPaths", () => {
  it("opens every ancestor of a nested path", () => {
    store().revealPaths(["a/b/c/file.ts"]);

    // The file's own path is not a folder, so it is not opened.
    expect([...store().expandedPaths].sort()).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("reveals many paths in a single update", () => {
    // The bug this replaces: one store write per folder. Fifty of those inside
    // an effect trips React's nested-update limit and crashes the tree.
    let writes = 0;
    const stop = useTreeStructureStore.subscribe(() => {
      writes += 1;
    });

    const many = Array.from({ length: 60 }, (_, i) => `dir${String(i)}/f.ts`);
    store().revealPaths(many);
    stop();

    expect(writes).toBe(1);
    expect(store().expandedPaths.size).toBe(60);
  });

  it("keeps the same Set when nothing new is opened", () => {
    store().revealPaths(["a/b/file.ts"]);
    const before = store().expandedPaths;

    store().revealPaths(["a/b/file.ts"]);

    // Identity, not contents: everything downstream re-renders off this, so a
    // fresh-but-equal Set is what makes a reveal-on-render loop forever.
    expect(store().expandedPaths).toBe(before);
  });

  it("notifies no subscriber when nothing changes", () => {
    store().revealPaths(["a/b/file.ts"]);

    let writes = 0;
    const stop = useTreeStructureStore.subscribe(() => {
      writes += 1;
    });
    store().revealPaths(["a/b/file.ts"]);
    stop();

    expect(writes).toBe(0);
  });

  it("still opens the genuinely new folders in a mixed batch", () => {
    store().revealPaths(["a/one.ts"]);
    store().revealPaths(["a/one.ts", "b/c/two.ts"]);

    expect([...store().expandedPaths].sort()).toEqual(["a", "b", "b/c"]);
  });

  it("ignores a top-level path, which has no ancestor to open", () => {
    const before = store().expandedPaths;
    store().revealPaths(["file.ts"]);
    expect(store().expandedPaths).toBe(before);
  });
});

describe("revealPath", () => {
  it("behaves like a one-element revealPaths", () => {
    store().revealPath("x/y/z.ts");
    expect([...store().expandedPaths].sort()).toEqual(["x", "x/y"]);
  });
});

describe("setExpandedPaths", () => {
  it("restores a remembered set", () => {
    store().setExpandedPaths(["a", "a/b"]);
    expect([...store().expandedPaths].sort()).toEqual(["a", "a/b"]);
  });

  it("keeps the same Set when the members already match", () => {
    store().setExpandedPaths(["a", "a/b"]);
    const before = store().expandedPaths;

    // The session subscription re-applies this on every store change, so an
    // unconditional write here feeds straight back into a loop.
    store().setExpandedPaths(["a/b", "a"]);

    expect(store().expandedPaths).toBe(before);
  });

  it("replaces the set when the members differ", () => {
    store().setExpandedPaths(["a"]);
    const before = store().expandedPaths;
    store().setExpandedPaths(["b"]);

    expect(store().expandedPaths).not.toBe(before);
    expect([...store().expandedPaths]).toEqual(["b"]);
  });
});

describe("collapseAll", () => {
  it("empties the set", () => {
    store().revealPaths(["a/b/c.ts"]);
    store().collapseAll();
    expect(store().expandedPaths.size).toBe(0);
  });

  it("keeps the same Set when it is already empty", () => {
    const before = store().expandedPaths;
    store().collapseAll();
    expect(store().expandedPaths).toBe(before);
  });
});

describe("toggleExpanded", () => {
  it("opens then closes a folder", () => {
    store().toggleExpanded("src");
    expect(store().expandedPaths.has("src")).toBe(true);

    store().toggleExpanded("src");
    expect(store().expandedPaths.has("src")).toBe(false);
  });
});
