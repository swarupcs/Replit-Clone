import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXCLUDED_DIRECTORIES } from "./projectService.js";

/** `fs.cp` hands its filter ABSOLUTE paths, and the exclusion was matched
 *  against the whole thing — prefix included. So a projects directory holding
 *  a segment named `dist`, `build` or `.git` excluded the copy's own root and
 *  produced an empty project, silently.
 *
 *  This exercises the same filter shape against a root that is deliberately
 *  under such a segment.
 */
const EXCLUDED_SEGMENT = new RegExp(
  `(^|[\\\\/])(${EXCLUDED_DIRECTORIES.map((name) => name.replace(/\./g, "\\.")).join("|")})([\\\\/]|$)`,
);

function excludedFromCopy(sourceRoot: string, entrySource: string): boolean {
  const relative = path.relative(sourceRoot, entrySource);
  if (relative === "") return false;
  return EXCLUDED_SEGMENT.test(relative);
}

const base = "/tmp/rc-copy-filter-test/build/projects/abc";

describe("the duplicate filter", () => {
  it("never excludes the source root itself", () => {
    // Even when the root sits under a directory named like an excluded one.
    expect(excludedFromCopy(base, base)).toBe(false);
  });

  it("keeps ordinary files under a root with an excluded name in its prefix", () => {
    expect(excludedFromCopy(base, `${base}/src/main.ts`)).toBe(false);
    expect(excludedFromCopy(base, `${base}/package.json`)).toBe(false);
  });

  it("still excludes those directories inside the project", () => {
    expect(excludedFromCopy(base, `${base}/node_modules`)).toBe(true);
    expect(excludedFromCopy(base, `${base}/node_modules/react/index.js`)).toBe(true);
    expect(excludedFromCopy(base, `${base}/dist/app.js`)).toBe(true);
    expect(excludedFromCopy(base, `${base}/.git/HEAD`)).toBe(true);
  });

  it("does not exclude a file merely named like one", () => {
    expect(excludedFromCopy(base, `${base}/dist.config.js`)).toBe(false);
    expect(excludedFromCopy(base, `${base}/src/build-tools.ts`)).toBe(false);
  });
});

describe("copying with that filter", () => {
  const root = "/tmp/rc-copy-filter-test/build/projects/src-project";
  const dest = "/tmp/rc-copy-filter-test/build/projects/dest-project";

  beforeEach(async () => {
    await fs.rm("/tmp/rc-copy-filter-test", { recursive: true, force: true });
    await fs.mkdir(`${root}/src`, { recursive: true });
    await fs.mkdir(`${root}/node_modules/dep`, { recursive: true });
    await fs.writeFile(`${root}/package.json`, "{}");
    await fs.writeFile(`${root}/src/main.ts`, "export const x = 1;");
    await fs.writeFile(`${root}/node_modules/dep/index.js`, "module.exports = 1;");
  });

  afterEach(async () => {
    await fs.rm("/tmp/rc-copy-filter-test", { recursive: true, force: true });
  });

  it("copies the project even from under a path named 'build'", async () => {
    await fs.cp(root, dest, {
      recursive: true,
      filter: (entrySource) => !excludedFromCopy(root, entrySource),
    });

    // The whole point: this used to come out empty.
    expect(await fs.readFile(`${dest}/package.json`, "utf8")).toBe("{}");
    expect(await fs.readFile(`${dest}/src/main.ts`, "utf8")).toContain("export");
  });

  it("leaves dependencies behind", async () => {
    await fs.cp(root, dest, {
      recursive: true,
      filter: (entrySource) => !excludedFromCopy(root, entrySource),
    });

    await expect(fs.stat(`${dest}/node_modules`)).rejects.toThrow();
  });
});
