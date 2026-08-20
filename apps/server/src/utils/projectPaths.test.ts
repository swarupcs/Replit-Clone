import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECTS_ROOT } from "../config/env.js";
import {
  assertValidProjectId,
  projectRoot,
  resolveInProject,
  toRelativePath,
} from "./projectPaths.js";

/** This module is the only thing standing between a WebSocket client and the
 *  server's filesystem, so its edges are worth pinning down explicitly. */

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("assertValidProjectId", () => {
  it("accepts a uuid in either case", () => {
    expect(assertValidProjectId(PROJECT)).toBe(PROJECT);
    expect(assertValidProjectId(PROJECT.toUpperCase())).toBe(
      PROJECT.toUpperCase(),
    );
  });

  it.each([
    ["empty", ""],
    ["a path segment", "../etc"],
    ["a shell metacharacter", `${PROJECT};rm -rf /`],
    ["a docker flag", `--privileged`],
    ["a truncated uuid", PROJECT.slice(0, 30)],
    ["trailing whitespace", `${PROJECT} `],
  ])("rejects %s", (_label, candidate) => {
    expect(() => assertValidProjectId(candidate)).toThrow(/Invalid project id/);
  });
});

describe("resolveInProject", () => {
  const root = projectRoot(PROJECT);

  it("resolves an ordinary relative path", () => {
    expect(resolveInProject(PROJECT, "src/main.tsx")).toBe(
      path.join(root, "src", "main.tsx"),
    );
  });

  it("treats an absolute-looking path as project-relative", () => {
    expect(resolveInProject(PROJECT, "/etc/passwd")).toBe(
      path.join(root, "etc", "passwd"),
    );
  });

  it("normalises Windows separators", () => {
    expect(resolveInProject(PROJECT, "src\\lib\\util.ts")).toBe(
      path.join(root, "src", "lib", "util.ts"),
    );
  });

  it("collapses interior traversal that stays inside the project", () => {
    expect(resolveInProject(PROJECT, "src/../package.json")).toBe(
      path.join(root, "package.json"),
    );
  });

  it("resolves the root itself", () => {
    expect(resolveInProject(PROJECT, "")).toBe(root);
  });

  it.each([
    ["parent traversal", "../secrets.txt"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal after a real segment", "src/../../../etc/passwd"],
    ["traversal via Windows separators", "..\\..\\etc\\passwd"],
  ])("rejects %s", (_label, relPath) => {
    expect(() => resolveInProject(PROJECT, relPath)).toThrow(
      /escapes the project root/,
    );
  });

  it("rejects a NUL byte, which would truncate the path inside libuv", () => {
    expect(() => resolveInProject(PROJECT, "safe.txt\0../../etc/passwd")).toThrow(
      /null byte/,
    );
  });

  it("does not let a sibling directory pass on a shared name prefix", () => {
    // `<root>-evil` starts with the root's own path, so a naive prefix check
    // would accept it.
    const sibling = `../${path.basename(root)}-evil/file.txt`;
    expect(() => resolveInProject(PROJECT, sibling)).toThrow(
      /escapes the project root/,
    );
  });

  it("never returns a path outside the projects root", () => {
    for (const relPath of ["a/b/c.ts", "./x", "y/../z", "/abs/path"]) {
      expect(resolveInProject(PROJECT, relPath).startsWith(PROJECTS_ROOT)).toBe(
        true,
      );
    }
  });
});

describe("toRelativePath", () => {
  it("is the inverse of resolveInProject, in POSIX form", () => {
    const absolute = resolveInProject(PROJECT, "src/components/App.tsx");
    expect(toRelativePath(PROJECT, absolute)).toBe("src/components/App.tsx");
  });

  it("reports the root as an empty path", () => {
    expect(toRelativePath(PROJECT, projectRoot(PROJECT))).toBe("");
  });
});
