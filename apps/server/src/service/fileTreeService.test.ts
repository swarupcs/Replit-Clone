import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TreeNodeData } from "@replit-clone/shared";
import { projectRoot } from "../utils/projectPaths.js";
import { buildFileTree } from "./fileTreeService.js";
import { canSymlink } from "../test/capabilities.js";

const PROJECT = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const root = projectRoot(PROJECT);

/** Flattens the tree to `relPath` strings, for readable assertions. */
function paths(node: TreeNodeData, into: string[] = []): string[] {
  if (node.relPath) into.push(node.relPath);
  node.children?.forEach((child) => paths(child, into));
  return into;
}

function childNames(node: TreeNodeData): string[] {
  return (node.children ?? []).map((child) => child.name);
}

beforeAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(`${root}/src/components`, { recursive: true });
  await fs.mkdir(`${root}/node_modules/left-pad`, { recursive: true });
  await fs.mkdir(`${root}/.git/objects`, { recursive: true });
  await fs.mkdir(`${root}/dist`, { recursive: true });

  await fs.writeFile(`${root}/package.json`, '{"name":"x"}');
  await fs.writeFile(`${root}/README.md`, "hello");
  await fs.writeFile(`${root}/src/main.tsx`, "main");
  await fs.writeFile(`${root}/src/components/App.tsx`, "app");
  await fs.writeFile(`${root}/node_modules/left-pad/index.js`, "nope");
  await fs.writeFile(`${root}/dist/bundle.js`, "nope");

  // A link pointing out of the project: it may be listed, but must never be
  // walked into, or the tree would expose the host's filesystem.
  //
  // Guarded because creating one needs privileges Windows withholds. Without
  // the guard this threw in beforeAll and took every test in the file with it
  // -- including the ones that have nothing to do with links.
  if (canSymlink) await fs.symlink("/etc", `${root}/escape`);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildFileTree", () => {
  it("emits paths relative to the project root, never host paths", async () => {
    const tree = await buildFileTree(PROJECT);

    expect(tree.relPath).toBe("");
    for (const relPath of paths(tree)) {
      expect(relPath.startsWith("/")).toBe(false);
      expect(relPath).not.toContain(root);
      expect(relPath).not.toContain("\\");
    }
  });

  it("includes the project's own files", async () => {
    const found = paths(await buildFileTree(PROJECT));

    expect(found).toContain("package.json");
    expect(found).toContain("src/main.tsx");
    expect(found).toContain("src/components/App.tsx");
  });

  it("omits directories the editor has no business browsing", async () => {
    const found = paths(await buildFileTree(PROJECT));

    for (const ignored of ["node_modules", ".git", "dist"]) {
      expect(found.some((relPath) => relPath.startsWith(ignored))).toBe(false);
    }
  });

  it.skipIf(!canSymlink)(
    "does not descend a symlink that leaves the project",
    async () => {
      const found = paths(await buildFileTree(PROJECT));

      expect(found.some((relPath) => relPath.startsWith("escape/"))).toBe(
        false,
      );
    },
  );

  it("puts directories first, then sorts case-insensitively", async () => {
    const tree = await buildFileTree(PROJECT);

    expect(childNames(tree)).toEqual(["src", "package.json", "README.md"]);
  });

  it("reports a size for files and children for directories", async () => {
    const tree = await buildFileTree(PROJECT);
    const src = tree.children?.find((child) => child.name === "src");
    const readme = tree.children?.find((child) => child.name === "README.md");

    expect(src?.type).toBe("directory");
    expect(src?.children?.length).toBe(2);
    expect(readme?.type).toBe("file");
    expect(readme?.size).toBe("hello".length);
  });
});
