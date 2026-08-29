import { beforeEach, describe, expect, it } from "vitest";
import {
  selectDecoration,
  selectFolderDecoration,
  useGitDecorationStore,
} from "./gitDecorationStore.ts";

const set = (changes: Parameters<
  ReturnType<typeof useGitDecorationStore.getState>["setChanges"]
>[0]) => useGitDecorationStore.getState().setChanges(changes);

const state = () => useGitDecorationStore.getState();

describe("file decorations", () => {
  beforeEach(() => useGitDecorationStore.getState().clear());

  it("decorates a changed file", () => {
    set([{ path: "src/a.ts", unstaged: "modified" }]);
    expect(selectDecoration("src/a.ts")(state())).toEqual({
      state: "modified",
      letter: "M",
    });
  });

  /** A row has one colour and `GitChange` has two sides. The working tree
   *  wins: it is what the file on disk actually has, and it is what someone
   *  scanning a tree is looking for. */
  it("prefers the working tree over the index when both differ", () => {
    set([{ path: "a.ts", staged: "added", unstaged: "modified" }]);
    expect(selectDecoration("a.ts")(state())?.state).toBe("modified");
  });

  it("falls back to the index when the working tree is clean", () => {
    set([{ path: "a.ts", staged: "added" }]);
    expect(selectDecoration("a.ts")(state())?.state).toBe("added");
  });

  it("ignores an entry with neither side set", () => {
    set([{ path: "a.ts" }]);
    expect(selectDecoration("a.ts")(state())).toBeUndefined();
  });

  it("says nothing about an unchanged file", () => {
    set([{ path: "a.ts", unstaged: "modified" }]);
    expect(selectDecoration("b.ts")(state())).toBeUndefined();
  });

  it("replaces the previous status rather than merging into it", () => {
    set([{ path: "a.ts", unstaged: "modified" }]);
    set([{ path: "b.ts", unstaged: "modified" }]);
    // A file that has been committed since must stop being decorated.
    expect(selectDecoration("a.ts")(state())).toBeUndefined();
  });

  it("gives each state its own letter", () => {
    set([
      { path: "a", unstaged: "added" },
      { path: "m", unstaged: "modified" },
      { path: "d", unstaged: "deleted" },
      { path: "r", unstaged: "renamed" },
      { path: "u", unstaged: "untracked" },
    ]);
    expect(
      ["a", "m", "d", "r", "u"].map((p) => selectDecoration(p)(state())?.letter),
    ).toEqual(["A", "M", "D", "R", "U"]);
  });
});

describe("folder decorations", () => {
  beforeEach(() => useGitDecorationStore.getState().clear());

  /** A collapsed folder containing a change shows the tint, which is what
   *  makes a change findable without expanding anything. */
  it("inherits from a file somewhere beneath it", () => {
    set([{ path: "src/deep/nested/a.ts", unstaged: "modified" }]);
    expect(selectFolderDecoration("src")(state())?.state).toBe("modified");
  });

  it("shows the most consequential state under it", () => {
    set([
      { path: "src/a.ts", unstaged: "untracked" },
      { path: "src/b.ts", unstaged: "modified" },
    ]);
    // The untracked file is probably build output; the modification is
    // probably work.
    expect(selectFolderDecoration("src")(state())?.state).toBe("modified");
  });

  it("carries the colour but never a letter", () => {
    set([{ path: "src/a.ts", unstaged: "modified" }]);
    // "M" on a folder would claim the folder itself changed.
    expect(selectFolderDecoration("src")(state())?.letter).toBe("");
  });

  /** The bug a naive `startsWith` would have: `src` must not pick up a
   *  change in a sibling called `src-generated`. */
  it("does not match a folder whose name it merely prefixes", () => {
    set([{ path: "src-generated/a.ts", unstaged: "modified" }]);
    expect(selectFolderDecoration("src")(state())).toBeUndefined();
  });

  it("does not decorate a folder from a file that merely shares its name", () => {
    set([{ path: "src", unstaged: "modified" }]);
    expect(selectFolderDecoration("src")(state())).toBeUndefined();
  });

  it("says nothing about a folder with nothing changed under it", () => {
    set([{ path: "other/a.ts", unstaged: "modified" }]);
    expect(selectFolderDecoration("src")(state())).toBeUndefined();
  });
});
