import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Docker is stubbed: what this pins down is when the server decides to start
 *  a project by itself, and — more importantly — when it decides not to. */

const ensureContainer = vi.fn();
const getPreviewTarget = vi.fn();

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getPreviewTarget: (): unknown => getPreviewTarget(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

let runner: typeof import("./runner.js");

/** One stream per exec, kept in order.
 *
 *  A single shared stream would be destroyed by the first stop, so the second
 *  run's process-group marker would never arrive, that stop would take the "no
 *  process group" path and leave the state alone — and a test expecting no
 *  restart would pass because the run never became stoppable, not because
 *  anything suppressed it.
 */
let streams: PassThrough[] = [];

function workingContainer(): void {
  ensureContainer.mockResolvedValue({
    exec: () => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({
        start: () => Promise.resolve(stream),
        inspect: () => Promise.resolve({ ExitCode: 0 }),
      });
    },
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Reports the current run's process group id, which is what makes a stop able
 *  to signal anything — and therefore able to reach `idle`. */
async function reportProcessGroup(): Promise<void> {
  streams.at(-1)?.write(`${runner.PGID_MARKER}4242\r\n`);
  await tick();
}

/** Starts by hand, the way the Run button does, and stops again. */
async function runThenStopByHand(): Promise<void> {
  await runner.startRun(PROJECT);
  await reportProcessGroup();
  await runner.stopRun(PROJECT);
}

beforeEach(async () => {
  vi.clearAllMocks();
  getPreviewTarget.mockResolvedValue(undefined);
  streams = [];
  runner = await import("./runner.js");
  runner.forgetRun(PROJECT);
});

describe("opening a project starts it", () => {
  it("starts the dev server without anyone pressing Run", async () => {
    workingContainer();

    await runner.autoStartRun(PROJECT);

    expect(ensureContainer).toHaveBeenCalledWith(PROJECT);
    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  /** The install step is not separate machinery — it is the front half of every
   *  template's start command, which is why opening a project installs its
   *  dependencies as well as serving it. */
  it("runs the install step as part of starting", async () => {
    const commands: string[][] = [];
    ensureContainer.mockResolvedValue({
      exec: (options: { Cmd: string[] }) => {
        const stream = new PassThrough();
        streams.push(stream);
        commands.push(options.Cmd);
        return Promise.resolve({
          start: () => Promise.resolve(stream),
          inspect: () => Promise.resolve({ ExitCode: 0 }),
        });
      },
    });

    await runner.autoStartRun(PROJECT);

    expect(commands.at(0)?.join(" ")).toContain("npm install");
    expect(commands.at(0)?.join(" ")).toContain("npm run dev");
  });

  it("starts one dev server when two tabs open the project at once", async () => {
    // Both subscribe in the same tick. `startRun` claims the state
    // synchronously before its own first await, which is what the second call
    // then sees; this pins that the two layers together still only start one.
    let resolveContainer: (value: unknown) => void = () => {};
    ensureContainer.mockImplementation(
      () => new Promise((resolve) => (resolveContainer = resolve)),
    );

    const first = runner.autoStartRun(PROJECT);
    const second = runner.autoStartRun(PROJECT);

    resolveContainer({
      exec: () => Promise.resolve({ start: () => Promise.resolve(null) }),
    });
    await Promise.allSettled([first, second]);

    expect(ensureContainer).toHaveBeenCalledTimes(1);
  });

  it("leaves a run that is already going alone", async () => {
    workingContainer();
    await runner.startRun(PROJECT);
    const callsAfterStart = ensureContainer.mock.calls.length;

    await runner.autoStartRun(PROJECT);

    expect(ensureContainer.mock.calls.length).toBe(callsAfterStart);
  });
});

/** The half that matters most. An automatic start that argues with the user is
 *  worse than no automatic start at all. */
describe("what it refuses to do", () => {
  /** The discriminating case for the suppression `stopRun` sets.
   *
   *  Starting by hand clears the suppression — that is what makes Run work
   *  again after a Stop — so the stop has to set it back. Coming at this from
   *  an automatic start instead proves nothing: the flag is already set by the
   *  automatic start itself, and the test would pass with the stop's own line
   *  deleted.
   */
  it("does not restart what the user started by hand and then stopped", async () => {
    workingContainer();
    await runThenStopByHand();
    expect(runner.getRunState(PROJECT).status).toBe("idle");

    const callsAfterStop = ensureContainer.mock.calls.length;
    // Another tab opens, or the page is reloaded.
    await runner.autoStartRun(PROJECT);

    expect(ensureContainer.mock.calls.length).toBe(callsAfterStop);
    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  it("does not restart one it started itself and the user then stopped", async () => {
    workingContainer();
    await runner.autoStartRun(PROJECT);
    await reportProcessGroup();
    await runner.stopRun(PROJECT);
    expect(runner.getRunState(PROJECT).status).toBe("idle");

    const callsAfterStop = ensureContainer.mock.calls.length;
    await runner.autoStartRun(PROJECT);

    expect(ensureContainer.mock.calls.length).toBe(callsAfterStop);
  });

  it("still lets the user start it again by hand afterwards", async () => {
    workingContainer();
    await runThenStopByHand();

    await runner.startRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  it("does not relaunch a run that exited on its own", async () => {
    workingContainer();
    // Started by hand, so the suppression flag is clear and `exited` is the
    // only thing standing between a crash and a relaunch. Coming at this from
    // an automatic start would leave the flag set and prove nothing.
    await runner.startRun(PROJECT);

    // The dev server dies.
    streams.at(-1)?.end();
    await tick();
    expect(runner.getRunState(PROJECT).status).toBe("exited");

    const callsAfterExit = ensureContainer.mock.calls.length;
    await runner.autoStartRun(PROJECT);

    // Never ready, so restarting it would just repeat the failure.
    expect(ensureContainer.mock.calls.length).toBe(callsAfterExit);
  });

  /** The report this grew from: a healthy dev server died (an OOM kill, most
   *  often), and refreshing the page left the project dead. Opening a project
   *  whose server USED to work should bring it back. */
  it("restarts on the next open a run that had been ready and then died", async () => {
    // Real clocks: the readiness probe and the restart cooldown are seconds
    // by design, and faking them stalls the real sockets the probe uses.
    // HTTP, not a bare socket: the readiness probe makes a request, because
    // accepting a connection and serving nothing is what Docker's published
    // port does for a container with no dev server in it.
    const listener = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end("ok");
    });
    try {
      workingContainer();
      // A real server on an ephemeral port, and the preview target pointed at
      // it, so the readiness probe genuinely succeeds.
      await new Promise<void>((resolve) =>
        listener.listen(0, "127.0.0.1", resolve),
      );
      const address = listener.address();
      getPreviewTarget.mockResolvedValue(
        `http://127.0.0.1:${String((address as AddressInfo).port)}`,
      );

      await runner.startRun(PROJECT);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(runner.getRunState(PROJECT).status).toBe("running");

      // The dev server dies.
      listener.close();
      streams.at(-1)?.end();
      await tick();
      expect(runner.getRunState(PROJECT).status).toBe("exited");

      // Immediately after the crash, a socket reconnecting is not a restart
      // trigger.
      await runner.autoStartRun(PROJECT);
      expect(ensureContainer).toHaveBeenCalledTimes(1);

      // Past the cooldown, a human refresh is.
      await new Promise((resolve) => setTimeout(resolve, 3100));
      await runner.autoStartRun(PROJECT);

      expect(ensureContainer).toHaveBeenCalledTimes(2);
      expect(runner.getRunState(PROJECT).status).toBe("starting");
    } finally {
      listener.close();
    }
  }, 20_000);

  it("stays quiet when there is no room for another container", async () => {
    ensureContainer.mockRejectedValue(new Error("container limit reached"));

    // Nobody asked for this, so it must not throw at the caller or leave the
    // project wedged.
    await expect(runner.autoStartRun(PROJECT)).resolves.toBeUndefined();
    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  it("tries again on the next open after a failure", async () => {
    ensureContainer.mockRejectedValueOnce(new Error("container limit reached"));
    await runner.autoStartRun(PROJECT);

    workingContainer();
    await runner.autoStartRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });
});
