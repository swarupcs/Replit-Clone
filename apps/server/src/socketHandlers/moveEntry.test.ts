import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot, resolveInProject } from "../utils/projectPaths.js";

const PROJECT = "8c1f9a20-4b7d-4e3a-9c8f-1d2e3f4a5b6c";
const root = projectRoot(PROJECT);

/** Mirrors the checks the moveEntry handler applies, so their edges are pinned
 *  down without needing a live socket. */
function planMove(relPath: string, destDir: string) {
  const absolute = resolveInProject(PROJECT, relPath);
  const name = path.posix.basename(relPath);
  const newRelPath = destDir ? `${destDir}/${name}` : name;
  const newAbsolute = resolveInProject(PROJECT, newRelPath);

  return {
    absolute,
    newAbsolute,
    newRelPath,
    isNoop: absolute === newAbsolute,
    intoItself: newAbsolute.startsWith(absolute + path.sep),
  };
}

describe("moveEntry planning", () => {
  it("moves a file into a folder", () => {
    const plan = planMove("main.ts", "src");

    expect(plan.newRelPath).toBe("src/main.ts");
    expect(plan.newAbsolute).toBe(path.join(root, "src", "main.ts"));
  });

  it("moves a file to the project root", () => {
    expect(planMove("src/main.ts", "").newRelPath).toBe("main.ts");
  });

  it("keeps only the basename, so a nested source lands flat", () => {
    expect(planMove("a/b/c/deep.ts", "target").newRelPath).toBe("target/deep.ts");
  });

  it("recognises a move that changes nothing", () => {
    expect(planMove("src/main.ts", "src").isNoop).toBe(true);
  });

  it("refuses to move a folder inside itself", () => {
    // This would detach the whole subtree from the tree.
    expect(planMove("src", "src/nested").intoItself).toBe(true);
  });

  it("allows a move to a sibling whose name shares a prefix", () => {
    // "src-vendor" is not inside "src", however similar the paths look.
    expect(planMove("src", "src-vendor").intoItself).toBe(false);
  });

  it.each([
    ["a parent traversal in the destination", "main.ts", "../escape"],
    ["a deep traversal", "main.ts", "../../../etc"],
    ["a traversal in the source", "../../../etc/passwd", "src"],
  ])("rejects %s", (_label, relPath, destDir) => {
    expect(() => planMove(relPath, destDir)).toThrow(/escapes the project root/);
  });

  it("never produces a destination outside the project", () => {
    for (const [source, dest] of [
      ["a.ts", "b"],
      ["a/b.ts", ""],
      ["deep/nested/c.ts", "other/place"],
    ]) {
      const plan = planMove(source ?? "", dest ?? "");
      expect(plan.newAbsolute.startsWith(root + path.sep)).toBe(true);
    }
  });
});
