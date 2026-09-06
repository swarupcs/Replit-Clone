import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// `vi.hoisted`, because `vi.mock` is lifted above every import and would
// otherwise close over a `const` that has not been initialised yet.
const logged = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../lib/logger.js", () => ({ logger: logged }));

import {
  PREVIEW_ADAPTATIONS,
  adaptForPreview,
} from "./previewContract.js";
import { TEMPLATE_FILES_ROOT } from "../templates/registry.js";

/** Making a "Latest" project reachable by the preview proxy.
 *
 *  Run against the REAL committed starters rather than fixtures, deliberately.
 *  The defect this fixes was a copy of the truth drifting from the truth — the
 *  registry describing a starter that "Latest" had replaced — and a test with
 *  its own invented `vite.config` would reproduce exactly that mistake one
 *  level down.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rc-preview-"));
  logged.info.mockClear();
  logged.error.mockClear();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** What `npm create vite@latest` leaves behind: a config with the framework
 *  plugin and nothing else. */
async function generatedViteProject(configName = "vite.config.ts") {
  await fs.writeFile(
    path.join(dir, configName),
    "import react from '@vitejs/plugin-react'\n" +
      "import { defineConfig } from 'vite'\n\n" +
      "export default defineConfig({ plugins: [react()] })\n",
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "app", private: true, scripts: { dev: "vite", build: "vite build" } },
      null,
      2,
    ),
  );
}

async function read(name: string): Promise<string> {
  return fs.readFile(path.join(dir, name), "utf8");
}

async function packageJson(): Promise<{ scripts: Record<string, string> }> {
  return JSON.parse(await read("package.json")) as {
    scripts: Record<string, string>;
  };
}

describe("what the generated project was missing", () => {
  /** The symptom: the dev server bound `[::1]:5173` inside the container, and
   *  the proxy dials the container's address on the sandbox network. */
  it("gives it a config that binds every interface", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "react-vite-ts", dir);

    expect(await read("vite.config.ts")).toContain('host: "0.0.0.0"');
  });

  /** What would have broken next. `expectsPreviewBase: true` makes the proxy
   *  forward /preview/<id>/ unchanged, and a generated app serves at `/`. */
  it("gives it the base the proxy serves it under", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "react-vite-ts", dir);

    expect(await read("vite.config.ts")).toContain("PREVIEW_BASE");
  });

  it("gives it an HMR path that dials back through the proxy", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "react-vite-ts", dir);

    expect(await read("vite.config.ts")).toContain("@vite-hmr");
  });

  /** Redundant with the config on purpose: a flag survives somebody editing a
   *  file we have just told them is theirs. */
  it("puts the same guarantees on the command line", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "react-vite-ts", dir);

    expect((await packageJson()).scripts.dev).toBe(
      "vite --host 0.0.0.0 --port 5173",
    );
  });
});

describe("not leaving two configs behind", () => {
  /** The silent one. Vite resolves `vite.config.js` before `vite.config.ts`,
   *  so ours written as `.ts` beside a generated `.js` would be ignored
   *  entirely — a preview that stays broken with the fix apparently applied. */
  it("removes a generated config whose extension differs from ours", async () => {
    await generatedViteProject("vite.config.js");

    await adaptForPreview(PROJECT, "react-vite-ts", dir);

    await expect(read("vite.config.js")).rejects.toThrow();
    expect(await read("vite.config.ts")).toContain('host: "0.0.0.0"');
  });

  it("leaves exactly one config however many the generator wrote", async () => {
    await generatedViteProject("vite.config.js");
    await fs.writeFile(path.join(dir, "vite.config.mjs"), "export default {}\n");

    await adaptForPreview(PROJECT, "react-vite", dir);

    const left = (await fs.readdir(dir)).filter((name) =>
      name.startsWith("vite.config."),
    );
    expect(left).toEqual(["vite.config.js"]);
  });
});

describe("every template that can be built with Latest", () => {
  /** The list here and the recipes seeded in the database have to agree. A
   *  template offered as "Latest" with no adaptation is one whose preview does
   *  not work, and nothing else would say so. */
  it("covers the six that have recipes", () => {
    expect(Object.keys(PREVIEW_ADAPTATIONS).sort()).toEqual([
      "nextjs",
      "nextjs-ts",
      "react-vite",
      "react-vite-ts",
      "svelte-vite",
      "vue-vite",
    ]);
  });

  /** The copy is from the committed starter, so a starter that stopped
   *  carrying the file would break this silently. */
  it.each(Object.entries(PREVIEW_ADAPTATIONS))(
    "%s has the starter file it copies",
    async (templateId, adaptation) => {
      const source = path.join(
        TEMPLATE_FILES_ROOT,
        templateId,
        adaptation.configFile,
      );

      await expect(fs.readFile(source, "utf8")).resolves.toBeTruthy();
    },
  );

  /** Next does not read a host from its config, so the flags are the only
   *  thing that binds it. */
  it("binds Next on the command line, where its config cannot", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }, null, 2),
    );

    await adaptForPreview(PROJECT, "nextjs", dir);

    expect((await packageJson()).scripts.dev).toBe(
      "next dev --hostname 0.0.0.0 --port 3000",
    );
    expect(await read("next.config.mjs")).toContain("basePath");
  });
});

describe("what it refuses to damage", () => {
  it("does nothing for a template that cannot be built with Latest", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "static-html", dir);

    expect(await read("vite.config.ts")).toContain("plugins: [react()]");
    expect((await packageJson()).scripts.dev).toBe("vite");
  });

  /** Without the early return the same template reaches the copy, throws on a
   *  starter file it never names, and is swallowed by the catch -- so the
   *  project is untouched either way and the assertion above cannot tell the
   *  difference. Found by mutation-testing. What it CAN tell is the noise: a
   *  logged error for a template that was never meant to be adapted is the
   *  kind of line somebody spends an afternoon on. */
  it("does not report a failure for a template it was never meant to adapt", async () => {
    await generatedViteProject();

    await adaptForPreview(PROJECT, "static-html", dir);

    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.info).not.toHaveBeenCalled();
  });

  /** Inventing one would make `detectStartCommand` report a command that runs
   *  nothing. */
  it("does not invent a dev script for a project that has none", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", scripts: { build: "vite build" } }, null, 2),
    );

    await adaptForPreview(PROJECT, "react-vite", dir);

    expect((await packageJson()).scripts.dev).toBeUndefined();
  });

  it("keeps everything else in the package.json", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: "app",
          type: "module",
          scripts: { dev: "vite", build: "vite build" },
          dependencies: { react: "^19.2.0" },
        },
        null,
        2,
      ),
    );

    await adaptForPreview(PROJECT, "react-vite", dir);

    const parsed = JSON.parse(await read("package.json")) as Record<string, unknown>;
    expect(parsed["type"]).toBe("module");
    expect(parsed["dependencies"]).toEqual({ react: "^19.2.0" });
    expect((parsed["scripts"] as Record<string, string>)["build"]).toBe(
      "vite build",
    );
  });

  /** A `package.json` that is not JSON is somebody's problem, and not one
   *  worth throwing away a finished scaffold over. */
  it("survives a package.json it cannot parse", async () => {
    await fs.writeFile(path.join(dir, "package.json"), "{ not json");

    await expect(
      adaptForPreview(PROJECT, "react-vite", dir),
    ).resolves.toBeUndefined();
    // The config still lands: the two halves are independent.
    expect(await read("vite.config.js")).toContain('host: "0.0.0.0"');
  });

  /** A project that is built and running but needs a flag to preview is a far
   *  better outcome than one marked FAILED because a copy did not work. */
  it("never throws, even with nowhere to write", async () => {
    await expect(
      adaptForPreview(PROJECT, "react-vite", path.join(dir, "does-not-exist")),
    ).resolves.toBeUndefined();
  });
});
