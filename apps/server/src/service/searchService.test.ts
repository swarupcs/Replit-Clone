import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRoot } from "../utils/projectPaths.js";
import { searchProject, SearchTimeoutError } from "./searchService.js";

const PROJECT = "5d8f2a10-6c3b-4e9d-9f11-2a3b4c5d6e7f";
const root = projectRoot(PROJECT);

const search = (query: string, options = {}) =>
  searchProject(PROJECT, { query, ...options });

beforeAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(`${root}/src`, { recursive: true });
  await fs.mkdir(`${root}/node_modules/dep`, { recursive: true });

  await fs.writeFile(
    `${root}/src/main.ts`,
    "const greeting = 'hello';\nexport function greet() {\n  return greeting;\n}\n",
  );
  await fs.writeFile(`${root}/src/other.ts`, "// greeting lives in main\nconst x = 1;\n");
  await fs.writeFile(`${root}/README.md`, "# Greeting\n\nSays hello.\n");
  await fs.writeFile(`${root}/node_modules/dep/index.js`, "var greeting = 1;\n");
  // A NUL byte makes this binary; matching inside it helps nobody.
  await fs.writeFile(`${root}/logo.png`, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("searchProject", () => {
  it("finds a literal across files", async () => {
    const { matches } = await search("greeting");
    const paths = new Set(matches.map((match) => match.relPath));

    expect(paths.has("src/main.ts")).toBe(true);
    expect(paths.has("src/other.ts")).toBe(true);
  });

  it("reports 1-based line and column, ready to hand to the editor", async () => {
    const { matches } = await search("export function");
    const hit = matches.find((match) => match.relPath === "src/main.ts");

    expect(hit?.line).toBe(2);
    expect(hit?.column).toBe(1);
  });

  it("is case-insensitive by default", async () => {
    const { matches } = await search("GREETING");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("honours case sensitivity when asked", async () => {
    const { matches } = await search("Greeting", { caseSensitive: true });

    // Only the README capitalises it.
    expect(matches.every((match) => match.relPath === "README.md")).toBe(true);
  });

  it("matches whole words only when asked", async () => {
    const loose = await search("greet");
    const strict = await search("greet", { wholeWord: true });

    expect(loose.matches.length).toBeGreaterThan(strict.matches.length);
  });

  it("treats the query literally unless told it is a regex", async () => {
    // As a regex this matches everything; as a literal, nothing.
    expect((await search("gree.ing")).matches).toHaveLength(0);
    expect((await search("gree.ing", { isRegex: true })).matches.length).toBeGreaterThan(0);
  });

  it("throws on a regex that does not compile, rather than returning nothing", async () => {
    // Silently returning no results would look like "not found".
    await expect(search("(unclosed", { isRegex: true })).rejects.toThrow();
  });

  it("skips directories the tree hides", async () => {
    const { matches } = await search("greeting");
    expect(matches.some((match) => match.relPath.startsWith("node_modules"))).toBe(false);
  });

  it("skips binary files", async () => {
    const { matches } = await search("PNG");
    expect(matches.some((match) => match.relPath.endsWith(".png"))).toBe(false);
  });

  it("returns nothing for an empty query rather than everything", async () => {
    expect((await search("")).matches).toHaveLength(0);
    expect((await search("   ")).matches).toHaveLength(0);
  });

  it("returns relative paths, never host paths", async () => {
    const { matches } = await search("greeting");

    for (const match of matches) {
      expect(match.relPath.startsWith("/")).toBe(false);
      expect(match.relPath).not.toContain(root);
    }
  });

  it("finds every occurrence in a file with repeats on separate lines", async () => {
    const { matches } = await search("greeting");
    const inMain = matches.filter((match) => match.relPath === "src/main.ts");

    // Lines 1 and 3 both mention it; a shared regex lastIndex used to skip one.
    expect(inMain.map((match) => match.line)).toEqual([1, 3]);
  });

  it("stops a pattern that would never finish, instead of hanging the server", async () => {
    // Catastrophic backtracking: this does not complete in any useful time on
    // a line of this length, and nothing can interrupt a match in progress.
    // Run on the main thread it took the whole process down with it.
    await fs.writeFile(`${root}/src/bait.txt`, `${"a".repeat(60)}!\n`);

    await expect(search("(a+)+$", { isRegex: true })).rejects.toBeInstanceOf(
      SearchTimeoutError,
    );

    await fs.rm(`${root}/src/bait.txt`, { force: true });
  }, 20_000);

  it("still answers normally after a search was abandoned", async () => {
    // The worker is per search, so one that had to be terminated leaves
    // nothing behind for the next.
    const { matches } = await search("greeting");
    expect(matches.length).toBeGreaterThan(0);
  });
});
