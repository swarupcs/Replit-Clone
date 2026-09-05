import { beforeEach, describe, expect, it, vi } from "vitest";

/** Building a project with the upstream scaffolder instead of a copy.
 *
 *  Two things here are worth more than the rest and both are about failure.
 *
 *  A recipe is a row in a table that becomes a command, so **`parseRecipe` is
 *  the boundary** — it is what stands between a migration typo and `docker
 *  exec` being handed `undefined`. And a scaffold takes minutes, so a restart
 *  in the middle of one is not an edge case: without `reconcileScaffolds` the
 *  dashboard says "Setting up" for ever, which is the wedge plan.md §2.26
 *  already fixed twice, for scheduled runs and for deployments.
 */

const projectUpdate = vi.hoisted(() => vi.fn());
const projectUpdateMany = vi.hoisted(() => vi.fn());
const recipeFindUnique = vi.hoisted(() => vi.fn());
const recipeFindMany = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { update: projectUpdate, updateMany: projectUpdateMany },
    scaffoldRecipe: { findUnique: recipeFindUnique, findMany: recipeFindMany },
  },
}));

const ensureContainer = vi.hoisted(() => vi.fn());
const removeContainer = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer,
  removeContainer,
}));

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("../containers/execCapture.js", () => ({ execCapture }));

const inspectDirectory = vi.hoisted(() => vi.fn());
vi.mock("./repoImportService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repoImportService.js")>();
  // The detectors are real: they are pure functions of a file list and a
  // package.json, and the point of running them here is that the SCAFFOLDER's
  // output decides the start command, not the template's guess.
  return { ...actual, inspectDirectory };
});

vi.mock("../utils/projectPaths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/projectPaths.js")>();
  return { ...actual, claimForSandbox: vi.fn(() => Promise.resolve()) };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ABANDONED_SCAFFOLD,
  parseRecipe,
  recipeFor,
  reconcileScaffolds,
  runScaffold,
  tail,
  templatesWithRecipes,
  type ScaffoldRecipe,
} from "./scaffoldService.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CONTAINER = { id: "c1" } as never;

const RECIPE: ScaffoldRecipe = {
  templateId: "react-vite",
  label: "Vite · React",
  argv: [
    ["npm", "create", "vite@latest", ".", "--", "--template", "react"],
    ["npm", "install"],
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  ensureContainer.mockResolvedValue(CONTAINER);
  execCapture.mockResolvedValue({ stdout: "done", stderr: "", exitCode: 0 });
  projectUpdate.mockResolvedValue({});
  projectUpdateMany.mockResolvedValue({ count: 0 });
  recipeFindUnique.mockResolvedValue({
    templateId: "react-vite",
    label: "Vite · React",
    argv: RECIPE.argv,
    enabled: true,
  });
  recipeFindMany.mockResolvedValue([{ templateId: "react-vite" }]);
  inspectDirectory.mockResolvedValue({
    files: ["package.json"],
    packageJson: { scripts: { dev: "vite" } },
  });
});

/** `argv` is a JSON column, so the type system has nothing to say about what is
 *  in it — and this is the value that becomes a command. */
describe("reading a recipe out of the database", () => {
  it("accepts a list of argv arrays", () => {
    expect(parseRecipe({ templateId: "t", label: "l", argv: RECIPE.argv })).toEqual({
      templateId: "t",
      label: "l",
      argv: RECIPE.argv,
    });
  });

  it.each([
    ["null", null],
    ["a bare string", "npm install"],
    ["an empty list", []],
    ["a list of strings rather than of arrays", ["npm", "install"]],
    ["a step with a non-string in it", [["npm", 7]]],
    ["a step with an empty word", [["npm", ""]]],
    ["an empty step", [[]]],
  ])("refuses %s", (_name, argv) => {
    expect(parseRecipe({ templateId: "t", label: "l", argv })).toBeNull();
  });

  it("is nothing for a template with no recipe", async () => {
    recipeFindUnique.mockResolvedValue(null);

    expect(await recipeFor("go-http")).toBeNull();
  });

  /** So a recipe upstream has broken can be turned off without deleting the
   *  record of what it used to be. */
  it("is nothing for a recipe that has been turned off", async () => {
    recipeFindUnique.mockResolvedValue({
      templateId: "react-vite",
      label: "x",
      argv: RECIPE.argv,
      enabled: false,
    });

    expect(await recipeFor("react-vite")).toBeNull();
  });

  it("offers Latest only for templates that have one", async () => {
    expect(await templatesWithRecipes()).toEqual(new Set(["react-vite"]));
  });
});

describe("running one", () => {
  it("runs every step, in order, inside the project's container", async () => {
    expect(await runScaffold(PROJECT, RECIPE)).toBe(true);

    expect(ensureContainer).toHaveBeenCalledWith(PROJECT);
    expect(execCapture).toHaveBeenCalledTimes(2);
    expect(execCapture.mock.calls[0]?.[1]).toEqual(RECIPE.argv[0]);
    expect(execCapture.mock.calls[1]?.[1]).toEqual(RECIPE.argv[1]);
  });

  /** An array, never a string. This is what keeps a table of commands a table
   *  of data rather than a remote code execution surface with extra steps. */
  it("hands the command over as argv, never to a shell", async () => {
    await runScaffold(PROJECT, RECIPE);

    for (const call of execCapture.mock.calls) {
      const argv = call[1] as string[];
      expect(Array.isArray(argv)).toBe(true);
      expect(argv).not.toContain("-c");
      expect(argv.join(" ")).not.toContain("&&");
    }
  });

  it("stops at the first step that fails, and does not run the rest", async () => {
    execCapture.mockResolvedValueOnce({
      stdout: "",
      stderr: "npm ERR! network timeout",
      exitCode: 1,
    });

    expect(await runScaffold(PROJECT, RECIPE)).toBe(false);
    expect(execCapture).toHaveBeenCalledTimes(1);
  });

  /** "Creation failed" is not something anybody can act on and "npm ERR!
   *  network timeout" is. The scaffolder is the only thing that knows why. */
  it("keeps the scaffolder's own words for the person to read", async () => {
    execCapture.mockResolvedValue({
      stdout: "",
      stderr: "npm ERR! network timeout",
      exitCode: 1,
    });

    await runScaffold(PROJECT, RECIPE);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scaffoldStatus: "FAILED",
          scaffoldLog: expect.stringContaining("network timeout") as unknown,
        }),
      }),
    );
  });

  /** Never awaited by its caller, so a rejection would be an unhandled one and
   *  would take the process with it. */
  it("does not throw when the container will not start", async () => {
    ensureContainer.mockRejectedValue(new Error("no daemon"));

    await expect(runScaffold(PROJECT, RECIPE)).resolves.toBe(false);
    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scaffoldStatus: "FAILED" }),
      }),
    );
  });

  /** The scaffolder's output is the authority on how to run what it produced,
   *  not the template's guess — the same reconcile the import path does. */
  it("takes the start command from what was actually produced", async () => {
    inspectDirectory.mockResolvedValue({
      files: ["package.json", "pnpm-lock.yaml"],
      packageJson: { scripts: { dev: "vite" } },
    });

    await runScaffold(PROJECT, RECIPE);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scaffoldStatus: "READY",
          startCommand: "pnpm install && pnpm run dev",
        }),
      }),
    );
  });

  /** A wrong guess is worse than the template's default, which is at least
   *  predictable from what the UI says the project is. */
  it("leaves the template's command alone when the output says nothing", async () => {
    inspectDirectory.mockResolvedValue({ files: [], packageJson: null });

    await runScaffold(PROJECT, RECIPE);

    const data = projectUpdate.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(data.data["scaffoldStatus"]).toBe("READY");
    expect(data.data).not.toHaveProperty("startCommand");
  });

  it("clears the failure log once it has succeeded", async () => {
    await runScaffold(PROJECT, RECIPE);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scaffoldLog: null }),
      }),
    );
  });
});

/** Without this the dashboard says "Setting up" for ever. plan.md §2.26 is the
 *  record of the same shape twice before. */
describe("a restart in the middle of one", () => {
  it("fails every scaffold that was in flight", async () => {
    projectUpdateMany.mockResolvedValue({ count: 2 });

    expect(await reconcileScaffolds()).toBe(2);
    expect(projectUpdateMany).toHaveBeenCalledWith({
      where: { scaffoldStatus: "SCAFFOLDING" },
      data: { scaffoldStatus: "FAILED", scaffoldLog: ABANDONED_SCAFFOLD },
    });
  });

  /** It says what is and is not known. Whatever the scaffolder had finished is
   *  still on disk, and pretending otherwise would be as wrong as saying
   *  nothing. */
  it("says what happened rather than that something failed", () => {
    expect(ABANDONED_SCAFFOLD).toMatch(/restarted/i);
    expect(ABANDONED_SCAFFOLD).toMatch(/still in the project/i);
  });

  it("touches nothing when none was running", async () => {
    expect(await reconcileScaffolds()).toBe(0);
  });
});

describe("the log that is kept", () => {
  /** A failing install produces tens of kilobytes and says what went wrong in
   *  the last twenty lines. All of it would be an unbounded string in a row a
   *  dashboard reads. */
  it("is the end of the output, which is where the reason is", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join("\n");

    const kept = tail(long);

    expect(kept.split("\n")).toHaveLength(40);
    expect(kept).toContain("line 199");
    expect(kept).not.toContain("line 1\n");
  });

  it("is bounded even when the output has no line breaks at all", () => {
    expect(tail("x".repeat(50_000)).length).toBeLessThanOrEqual(8000);
  });

  it("is empty rather than whitespace when there was no output", () => {
    expect(tail("   \n\n")).toBe("");
  });
});
