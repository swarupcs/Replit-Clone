import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Docker is not available here, so the container layer is stubbed. What these
 *  pin down is the run's own bookkeeping — the part that was wrong regardless
 *  of whether a daemon was reachable. */

const ensureContainer = vi.fn();
const getPreviewTarget = vi.fn(() => Promise.resolve(undefined));

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getPreviewTarget: (): unknown => getPreviewTarget(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const PROJECT = "3c5e7a90-1b2d-4e6f-8a9b-0c1d2e3f4a5b";

let runner: typeof import("./runner.js");

beforeEach(async () => {
  vi.clearAllMocks();
  runner = await import("./runner.js");
  runner.forgetRun(PROJECT);
});

describe("starting a run", () => {
  it("starts one dev server when Run is pressed twice in the same tick", async () => {
    // The guard checked the state, then awaited twice before setting it, so
    // both calls passed and both started a dev server — the second failing to
    // bind the port, its output arriving from a process nothing tracked.
    let resolveContainer: (value: unknown) => void = () => {};
    ensureContainer.mockImplementation(
      () => new Promise((resolve) => (resolveContainer = resolve)),
    );

    const first = runner.startRun(PROJECT);
    const second = runner.startRun(PROJECT);

    resolveContainer({
      exec: () => Promise.resolve({ start: () => Promise.resolve(null) }),
    });
    await Promise.allSettled([first, second]);

    expect(ensureContainer).toHaveBeenCalledTimes(1);
  });

  it("can be run again after a failed start", async () => {
    // The claim has to be released on failure, or the project is unrunnable
    // until the server restarts.
    ensureContainer.mockRejectedValueOnce(new Error("no capacity"));

    await expect(runner.startRun(PROJECT)).rejects.toThrow(/capacity/);
    expect(runner.getRunState(PROJECT).status).toBe("idle");

    ensureContainer.mockRejectedValueOnce(new Error("still no capacity"));
    await expect(runner.startRun(PROJECT)).rejects.toThrow();

    // Reached the container a second time rather than returning early.
    expect(ensureContainer).toHaveBeenCalledTimes(2);
  });
});

describe("stopping a run", () => {
  it("says so rather than claiming success when it has no process group", async () => {
    // The launcher prints its process group id first thing. When that never
    // arrives there is nothing to signal — and the old code ran `true` in the
    // container, printed "Stopped." and set the state idle, while the dev
    // server carried on holding the port. The next Run then looked broken for
    // no reason anyone could see.
    const stream = new PassThrough();
    ensureContainer.mockResolvedValue({
      exec: () =>
        Promise.resolve({
          start: () => Promise.resolve(stream),
          inspect: () => Promise.resolve({ ExitCode: 0 }),
        }),
    });

    await runner.startRun(PROJECT);

    // Output arrives, but no marker line among it.
    stream.write("vite v5 ready\r\n");
    await new Promise((resolve) => setImmediate(resolve));

    const callsBeforeStop = ensureContainer.mock.calls.length;
    await runner.stopRun(PROJECT);

    // It did not reach the container to run a kill that could do nothing.
    expect(ensureContainer.mock.calls.length).toBe(callsBeforeStop);

    const log = runner.getRunHistory(PROJECT).join("");
    expect(log).toMatch(/could not stop/i);
    expect(log).not.toMatch(/stopped\./i);

    // And it does NOT claim to be idle, because the process is still there.
    expect(runner.getRunState(PROJECT).status).not.toBe("idle");
  });

  it("signals the process group when it has one", async () => {
    const stream = new PassThrough();
    const started: string[][] = [];

    ensureContainer.mockResolvedValue({
      exec: (options: { Cmd: string[] }) => {
        started.push(options.Cmd);
        return Promise.resolve({
          start: () => Promise.resolve(stream),
          inspect: () => Promise.resolve({ ExitCode: 0 }),
        });
      },
    });

    await runner.startRun(PROJECT);

    stream.write(`${runner.PGID_MARKER}4242\r\n`);
    await new Promise((resolve) => setImmediate(resolve));

    await runner.stopRun(PROJECT);

    const kill = started.at(-1)?.join(" ") ?? "";
    expect(kill).toContain("kill -TERM -4242");
    expect(kill).toContain("kill -KILL -4242");
    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });
});
