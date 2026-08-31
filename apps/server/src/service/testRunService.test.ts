import { beforeEach, describe, expect, it, vi } from "vitest";

/** Running a project's tests.
 *
 *  What is worth pinning is the same thing §2.15 had to fix in the scheduler:
 *  the difference between "your tests failed" and "we could not run them".
 *  A panel that reports the second as the first sends somebody to read their
 *  own code for a Docker outage.
 */
const projectFindUnique = vi.hoisted(() => vi.fn());
const projectUpdate = vi.hoisted(() => vi.fn());

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique, update: projectUpdate },
  },
}));

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn(() => Promise.resolve({ id: "c1" })),
}));
vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveTestCommand, runTests, setTestCommand } from "./testRunService.js";

/** A project on a template that has a default test command. */
const onNode = (testCommand: string | null = null) => {
  projectFindUnique.mockResolvedValue({ testCommand, template: "react-vite" });
};

/** A template that deliberately has none. */
const onStatic = (testCommand: string | null = null) => {
  projectFindUnique.mockResolvedValue({ testCommand, template: "static-html" });
};

const exits = (code: number, stdout = "", stderr = "") => {
  execCapture.mockResolvedValue({ exitCode: code, stdout, stderr });
};

beforeEach(() => {
  projectFindUnique.mockReset();
  projectUpdate.mockReset().mockResolvedValue({});
  execCapture.mockReset();
});

describe("what a project's tests are", () => {
  it("falls back to the template's default", async () => {
    onNode();
    await expect(resolveTestCommand("p1")).resolves.toEqual({
      command: "npm test",
      fromTemplate: true,
    });
  });

  it("prefers the project's own", async () => {
    onNode("npm run test:ci");
    await expect(resolveTestCommand("p1")).resolves.toEqual({
      command: "npm run test:ci",
      fromTemplate: false,
    });
  });

  it("answers null for a template with nothing to test", async () => {
    // static-html has no tests, and a template that guessed would run a
    // command failing for a reason its author cannot act on.
    onStatic();
    // `fromTemplate` is false here rather than true: nothing came from the
    // template. Saying otherwise would claim it supplied a command it does not
    // have, and the panel reads this field to decide what to tell somebody.
    await expect(resolveTestCommand("p1")).resolves.toEqual({
      command: null,
      fromTemplate: false,
    });
  });

  it("still takes an override on such a template", async () => {
    onStatic("npx playwright test");
    await expect(resolveTestCommand("p1")).resolves.toMatchObject({
      command: "npx playwright test",
      fromTemplate: false,
    });
  });

  it("clears back to the template's default when set to empty", async () => {
    onNode("npm run test:ci");
    await setTestCommand("p1", "   ");

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { testCommand: null } }),
    );
  });

  it("trims what it stores", async () => {
    onNode();
    await setTestCommand("p1", "  npm test  ");

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { testCommand: "npm test" } }),
    );
  });
});

describe("running them", () => {
  it("passes on exit 0", async () => {
    onNode();
    exits(0, "12 passed");

    const run = await runTests("p1");

    expect(run).toMatchObject({ status: "PASSED", exitCode: 0 });
    expect(run.output).toContain("12 passed");
  });

  it("fails on a non-zero exit, and keeps the output", async () => {
    // The useful case: the output IS the answer, and a status with no output
    // sends somebody back to a terminal.
    onNode();
    exits(1, "", "1 failing\n  expected 2 to equal 3");

    const run = await runTests("p1");

    expect(run).toMatchObject({ status: "FAILED", exitCode: 1 });
    expect(run.output).toContain("expected 2 to equal 3");
  });

  it("says which command produced the result", async () => {
    // "Tests failed" is not actionable without knowing what ran.
    onNode("npm run test:ci");
    exits(1);

    await expect(runTests("p1")).resolves.toMatchObject({
      command: "npm run test:ci",
    });
  });

  it("does not blame the tests when the machine could not run them", async () => {
    // ERRORED, not FAILED. This is the distinction §2.15 had to repair in the
    // scheduler after it reported a crashed exec as a timeout.
    onNode();
    execCapture.mockRejectedValue(new Error("docker is down"));

    const run = await runTests("p1");

    expect(run.status).toBe("ERRORED");
    expect(run.exitCode).toBeNull();
    expect(run.output).toContain("docker is down");
  });

  it("refuses when nothing says what the tests are", async () => {
    onStatic();

    await expect(runTests("p1")).rejects.toMatchObject({
      code: "NO_TEST_COMMAND",
    });
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("runs the command through a shell, so `a && b` works", async () => {
    onNode("npm ci && npm test");
    exits(0);

    await runTests("p1");

    expect(execCapture).toHaveBeenCalledWith(
      { id: "c1" },
      ["/bin/sh", "-lc", "npm ci && npm test"],
    );
  });

  it("keeps the tail of very long output", async () => {
    // A failing suite prints its failures last, which is the part worth
    // having.
    onNode();
    exits(1, `${"x".repeat(80_000)}THE-FAILURE`);

    const run = await runTests("p1");

    expect(run.output).toContain("THE-FAILURE");
    expect(run.output).toContain("earlier characters not shown");
    expect(run.output.length).toBeLessThan(80_000);
  });
});
