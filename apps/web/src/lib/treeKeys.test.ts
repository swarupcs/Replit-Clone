import { describe, expect, it } from "vitest";
import { treeKeyAction } from "./treeKeys.ts";

/** A project with one collapsed folder, one expanded folder holding two files,
 *  and a file at the top level — enough shape for every rule to have somewhere
 *  to go and somewhere to refuse. */
const ORDER = [
  "closed",
  "open",
  "open/a.ts",
  "open/b.ts",
  "readme.md",
];

/** Defaults for a file row, so each test states only what it is about. */
function ctx(overrides: Partial<Parameters<typeof treeKeyAction>[0]>) {
  return treeKeyAction({
    key: "ArrowDown",
    from: "readme.md",
    kind: "file",
    isExpanded: false,
    visibleOrder: ORDER,
    ...overrides,
  });
}

describe("treeKeyAction", () => {
  describe("moving", () => {
    it("Down goes to the next row on screen", () => {
      expect(ctx({ key: "ArrowDown", from: "open/a.ts" })).toEqual({
        kind: "focus",
        relPath: "open/b.ts",
      });
    });

    it("Up goes to the previous row on screen", () => {
      expect(ctx({ key: "ArrowUp", from: "open/a.ts" })).toEqual({
        kind: "focus",
        relPath: "open",
      });
    });

    it("stops at the ends rather than wrapping", () => {
      expect(ctx({ key: "ArrowUp", from: "closed" })).toBeNull();
      expect(ctx({ key: "ArrowDown", from: "readme.md" })).toBeNull();
    });

    it("Home and End reach the first and last rows", () => {
      expect(ctx({ key: "Home", from: "open/b.ts" })).toEqual({
        kind: "focus",
        relPath: "closed",
      });
      expect(ctx({ key: "End", from: "closed" })).toEqual({
        kind: "focus",
        relPath: "readme.md",
      });
    });

    it("does nothing when it is already there", () => {
      expect(ctx({ key: "Home", from: "closed" })).toBeNull();
      expect(ctx({ key: "End", from: "readme.md" })).toBeNull();
    });
  });

  describe("Right", () => {
    it("opens a closed folder", () => {
      expect(
        ctx({ key: "ArrowRight", from: "closed", kind: "directory" }),
      ).toEqual({ kind: "expand", relPath: "closed" });
    });

    it("steps into a folder that is already open", () => {
      expect(
        ctx({
          key: "ArrowRight",
          from: "open",
          kind: "directory",
          isExpanded: true,
        }),
      ).toEqual({ kind: "focus", relPath: "open/a.ts" });
    });

    it("does nothing on a file", () => {
      expect(ctx({ key: "ArrowRight", from: "readme.md" })).toBeNull();
    });
  });

  describe("Left", () => {
    it("closes a folder that is open", () => {
      expect(
        ctx({
          key: "ArrowLeft",
          from: "open",
          kind: "directory",
          isExpanded: true,
        }),
      ).toEqual({ kind: "collapse", relPath: "open" });
    });

    it("goes out to the containing folder from a file inside it", () => {
      expect(ctx({ key: "ArrowLeft", from: "open/a.ts" })).toEqual({
        kind: "focus",
        relPath: "open",
      });
    });

    it("goes out from a closed folder, which has nothing to close", () => {
      // Left on a collapsed folder means "out", the same as it does on a file.
      expect(
        ctx({
          key: "ArrowLeft",
          from: "open/nested",
          kind: "directory",
          visibleOrder: [...ORDER, "open/nested"],
        }),
      ).toEqual({ kind: "focus", relPath: "open" });
    });

    it("does nothing at the top level, which has no parent row", () => {
      // The project root is not a row of its own, so there is nowhere to go.
      expect(ctx({ key: "ArrowLeft", from: "readme.md" })).toBeNull();
    });
  });

  describe("activating", () => {
    it("Enter and Space both activate the focused row", () => {
      for (const key of ["Enter", " "]) {
        expect(ctx({ key, from: "open/a.ts" })).toEqual({
          kind: "activate",
          relPath: "open/a.ts",
        });
      }
    });
  });

  it("ignores keys it has no meaning for", () => {
    expect(ctx({ key: "x" })).toBeNull();
    expect(ctx({ key: "Escape" })).toBeNull();
  });

  it("refuses to move from a row that is not on screen", () => {
    // Focus and the visible order can go out of step for a frame after a
    // folder collapses. Moving relative to a row that is not there would land
    // somewhere arbitrary; doing nothing is recoverable.
    expect(ctx({ key: "ArrowDown", from: "gone.ts" })).toBeNull();
  });
});
