import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRoot } from "../utils/projectPaths.js";
import { readProjectSources } from "./projectSourcesService.js";

const PROJECT = "5c2f1a90-7e43-4d8b-9a16-3f8e2c7b1d40";
const root = projectRoot(PROJECT);

/** The relative paths returned, sorted for stable assertions. */
async function paths(): Promise<string[]> {
  const { files } = await readProjectSources(PROJECT);
  return files.map((file) => file.relPath).sort();
}

beforeAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(`${root}/src/components`, { recursive: true });
  await fs.mkdir(`${root}/node_modules/left-pad`, { recursive: true });
  await fs.mkdir(`${root}/.git`, { recursive: true });
  await fs.mkdir(`${root}/dist`, { recursive: true });

  await fs.writeFile(`${root}/src/App.tsx`, "export const App = () => null;");
  await fs.writeFile(`${root}/src/util.ts`, "export const one = 1;");
  await fs.writeFile(`${root}/src/legacy.js`, "module.exports = {};");
  await fs.writeFile(`${root}/src/components/Button.tsx`, "export const B = 1;");

  // Not source: nothing the language service can use.
  await fs.writeFile(`${root}/README.md`, "hello");
  await fs.writeFile(`${root}/src/styles.css`, "body{}");
  await fs.writeFile(`${root}/logo.png`, "not really a png");

  // Should never be walked.
  await fs.writeFile(`${root}/node_modules/left-pad/index.js`, "module.exports=1");
  await fs.writeFile(`${root}/dist/bundle.js`, "minified");
  await fs.writeFile(`${root}/.git/hook.js`, "nope");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("readProjectSources", () => {
  it("returns the project's TypeScript and JavaScript files", async () => {
    expect(await paths()).toEqual([
      "src/App.tsx",
      "src/components/Button.tsx",
      "src/legacy.js",
      "src/util.ts",
    ]);
  });

  it("returns each file's contents", async () => {
    const { files } = await readProjectSources(PROJECT);
    const app = files.find((file) => file.relPath === "src/App.tsx");

    expect(app?.contents).toBe("export const App = () => null;");
  });

  it("skips files the language service cannot use", async () => {
    const found = await paths();

    expect(found).not.toContain("README.md");
    expect(found).not.toContain("src/styles.css");
    expect(found).not.toContain("logo.png");
  });

  it("never walks node_modules, dist or .git", async () => {
    const found = await paths();

    expect(found.some((file) => file.includes("node_modules"))).toBe(false);
    expect(found.some((file) => file.startsWith("dist/"))).toBe(false);
    expect(found.some((file) => file.startsWith(".git/"))).toBe(false);
  });

  it("uses POSIX separators, which is what a model URI needs", async () => {
    const found = await paths();

    expect(found).toContain("src/components/Button.tsx");
    expect(found.some((file) => file.includes("\\"))).toBe(false);
  });

  it("is not truncated for a small project", async () => {
    const { truncated } = await readProjectSources(PROJECT);
    expect(truncated).toBe(false);
  });

  it("skips a file too large to be worth shipping", async () => {
    const big = `${root}/src/huge.ts`;
    // Over the 256 KB per-file cap.
    await fs.writeFile(big, "x".repeat(300 * 1024));

    try {
      expect(await paths()).not.toContain("src/huge.ts");
    } finally {
      await fs.rm(big, { force: true });
    }
  });

  it("says so when a cap stopped the walk", async () => {
    const many = `${root}/generated`;
    await fs.mkdir(many, { recursive: true });

    try {
      // Past the 400-file cap.
      for (let i = 0; i < 420; i += 1) {
        await fs.writeFile(`${many}/f${String(i)}.ts`, "export const x = 1;");
      }

      const { files, truncated } = await readProjectSources(PROJECT);

      expect(truncated).toBe(true);
      expect(files.length).toBeLessThanOrEqual(400);
    } finally {
      await fs.rm(many, { recursive: true, force: true });
    }
  });

  it("returns nothing for a project that is not there", async () => {
    const { files, truncated } = await readProjectSources(
      "1f0c6e22-8a4b-4c19-9d33-77a1b5e6c9f2",
    );

    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });
});
