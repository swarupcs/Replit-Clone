import http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A dev server outlives the server process that started it. These pin down
 *  what happens when the two disagree — which is every restart, and therefore
 *  every reload of the page afterwards. */

const ensureContainer = vi.fn();
const getRunningContainer = vi.fn();
const getPreviewTarget = vi.fn<() => Promise<string | undefined>>();
const execCapture =
  vi.fn<
    (
      container: unknown,
      argv: string[],
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  >();

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getRunningContainer: (projectId: string): unknown =>
    getRunningContainer(projectId),
  getPreviewTarget: (): unknown => getPreviewTarget(),
}));

vi.mock("./execCapture.js", () => ({
  execCapture: (container: unknown, argv: string[]): unknown =>
    execCapture(container, argv),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

let runner: typeof import("./runner.js");

/** A real HTTP server, because "is a dev server up" is answered by making a
 *  request to one. A bare TCP listener would not do: accepting a connection and
 *  serving nothing is precisely what Docker's published-port proxy does for a
 *  container with no dev server in it, and telling those two apart is the
 *  probe's whole job. */
let devServer: http.Server | undefined;

/** Every command handed to the container, which is how a stop is observed: it
 *  signals a process group and reports nothing else. */
let commands: string[][] = [];

async function devServerListening(): Promise<void> {
  devServer = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    devServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = devServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  getPreviewTarget.mockResolvedValue(`http://127.0.0.1:${String(port)}`);
}

/** Streams handed to the log follower, so a test can assert it attached and
 *  the fixture can push output down it. */
let followerStreams: PassThrough[] = [];

/** What the container says when asked its two questions.
 *
 *  `pgid` is the process group the run recorded — undefined for a run that has
 *  finished, or one whose recorded pid the kernel has since reused. `recorded`
 *  is the run's own output, kept inside the container so a server that has
 *  restarted can replay it; undefined means there is no recording to read.
 */
function containerReports(
  pgid: string | undefined,
  recorded?: string,
): void {
  getRunningContainer.mockResolvedValue({
    id: "container",
    exec: (options: { Cmd: string[] }) => {
      commands.push(options.Cmd);
      const stream = new PassThrough();
      followerStreams.push(stream);
      return Promise.resolve({
        start: () => Promise.resolve(stream),
        inspect: () => Promise.resolve({ ExitCode: 0 }),
      });
    },
  });

  execCapture.mockImplementation((_container, argv) => {
    const command = argv.join(" ");

    if (command.includes("rc-run.log")) {
      return Promise.resolve(
        recorded === undefined
          ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: recorded, stderr: "", exitCode: 0 },
      );
    }

    return Promise.resolve({
      stdout: pgid === undefined ? "" : `${runner.PGID_MARKER}${pgid}\n`,
      stderr: "",
      exitCode: 0,
    });
  });
}

/** A container whose exec Docker still reports as running, which is what a run
 *  in the middle of `npm install` looks like. */
function liveExecContainer(): void {
  commands = [];
  ensureContainer.mockResolvedValue({
    exec: (options: { Cmd: string[] }) => {
      commands.push(options.Cmd);
      return Promise.resolve({
        start: () => Promise.resolve(new PassThrough()),
        inspect: () => Promise.resolve({ Running: true }),
      });
    },
  });
}

function stoppableContainer(): void {
  commands = [];
  ensureContainer.mockResolvedValue({
    exec: (options: { Cmd: string[] }) => {
      commands.push(options.Cmd);
      return Promise.resolve({
        start: () => Promise.resolve({ destroy: () => undefined }),
        inspect: () => Promise.resolve({ ExitCode: 0 }),
      });
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  followerStreams = [];
  getPreviewTarget.mockResolvedValue(undefined);
  getRunningContainer.mockResolvedValue(undefined);
  runner = await import("./runner.js");
  runner.forgetRun(PROJECT);
  stoppableContainer();
});

afterEach(async () => {
  runner.forgetRun(PROJECT);
  await new Promise<void>((resolve) => {
    if (!devServer) {
      resolve();
      return;
    }
    devServer.close(() => resolve());
  });
  devServer = undefined;
});

describe("a dev server that outlived the server process", () => {
  it("is running again as soon as someone opens the project", async () => {
    await devServerListening();
    containerReports("4242");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  it("reports the command it is running, so the UI is not blank", async () => {
    await devServerListening();
    containerReports("4242");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).command).toContain("npm run dev");
  });

  /** The preview pane waits for this. A fresh start sends it when the port
   *  starts answering; an adopted run's port is already answering, so nothing
   *  would ever tell the pane to load. */
  it("tells the preview it is live", async () => {
    await devServerListening();
    containerReports("4242");
    const events: string[] = [];
    const release = runner.subscribe(PROJECT, (event) => events.push(event.type));

    await runner.reconcileRun(PROJECT);
    release();

    expect(events).toContain("ready");
  });

  it("can be stopped, because it recovers the process group", async () => {
    await devServerListening();
    containerReports("4242");
    await runner.reconcileRun(PROJECT);

    await runner.stopRun(PROJECT);

    expect(commands.at(-1)?.join(" ")).toContain("-4242");
    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  /** The whole point. Before this, a reload found `idle` and launched a second
   *  dev server into a port the first one was still holding — so the run the
   *  user could see reported as broken, while the one they could not see went
   *  on serving the preview. */
  it("stops the reload from starting a second one on top of it", async () => {
    await devServerListening();
    containerReports("4242");
    await runner.reconcileRun(PROJECT);

    await runner.autoStartRun(PROJECT);

    expect(ensureContainer).not.toHaveBeenCalled();
    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  /** The run records its output inside the container precisely so this can be
   *  read back. Without it the project came back with a "Running" badge over a
   *  pane that was empty and would stay empty — the dev server was still
   *  talking, but to a process that no longer existed. */
  it("replays what the run said before the server restarted", async () => {
    await devServerListening();
    containerReports("4242", "> next dev\r\nready on :3000\r\n");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain("ready on :3000");
  });

  /** The launcher prints its process group id for the live stream to pick up,
   *  and `script` records that faithfully along with everything else. Replayed
   *  unfiltered, the pane opens with our own bookkeeping above the user's
   *  output. */
  it("keeps the launcher's own marker out of the replay", async () => {
    await devServerListening();
    containerReports(
      "4242",
      `${runner.PGID_MARKER}4242\r\n> next dev\r\n`,
    );

    await runner.reconcileRun(PROJECT);

    const log = runner.getRunHistory(PROJECT).join("");
    expect(log).toContain("> next dev");
    expect(log).not.toContain(runner.PGID_MARKER);
  });

  /** A replay is a snapshot. Everything the dev server says AFTER it has to
   *  arrive too, or the pane is frozen at the moment of the reload — which is
   *  the same empty pane, just with a head start. */
  it("goes on showing what the run says next", async () => {
    await devServerListening();
    containerReports("4242", "> next dev\r\n");
    await runner.reconcileRun(PROJECT);

    expect(followerStreams).toHaveLength(1);
    followerStreams[0]?.write("compiled in 84ms\r\n");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runner.getRunHistory(PROJECT).join("")).toContain("compiled in 84ms");
  });

  it("says so when there is no recording to replay", async () => {
    await devServerListening();
    containerReports("4242");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain("not recorded");
  });
});

/** Opening a NEW project runs `npm install` before the dev server, which is
 *  minutes of the only feedback there is. Reload during it and this process
 *  holds no exec, nothing is listening, and the run used to read as a project
 *  nobody had ever started — so opening it launched a SECOND install into the
 *  same directory as the first. */
describe("a run still installing when the server restarted", () => {
  function installing(recorded?: string): void {
    containerReports("4242", recorded);
    // Nothing bound: the install has not reached the dev server yet.
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");
  }

  it("is taken over rather than treated as never started", async () => {
    installing();

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  it("is not started a second time on top of itself", async () => {
    installing();
    await runner.reconcileRun(PROJECT);

    await runner.autoStartRun(PROJECT);

    expect(ensureContainer).not.toHaveBeenCalled();
  });

  /** The install's own output is the progress bar. */
  it("replays the install's output so far", async () => {
    installing("added 214 packages\r\n");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain("added 214 packages");
  });

});

describe("when there is nothing to adopt", () => {
  it("leaves a project with no container alone", async () => {
    await devServerListening();
    getRunningContainer.mockResolvedValue(undefined);

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  /** A container is up long before its dev server has bound a port, and it
   *  stays up long after one has died. Adopting on the container's existence
   *  would report `running` for a project that serves nothing — so with
   *  nothing listening AND no live process group, there is nothing there. */
  it("leaves a container with nothing running in it alone", async () => {
    containerReports(undefined);
    // Nothing is bound here, so the probe's connection is refused.
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  /** Reconciling asks Docker two questions, and a Run pressed while it is
   *  waiting for the answers wins: `startRun` claims the session before its own
   *  first await. Adoption must notice that on the way back, or it reports
   *  `running` for a dev server that is still running `npm install` — and
   *  overwrites the process group of the run that is actually there. */
  it("gives way to a Run pressed while it was still asking", async () => {
    await devServerListening();
    containerReports("4242");

    let answer: (value: unknown) => void = () => undefined;
    getRunningContainer.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const adopting = runner.reconcileRun(PROJECT);

    ensureContainer.mockResolvedValue({
      exec: () =>
        Promise.resolve({
          start: () => Promise.resolve(new PassThrough()),
          inspect: () => Promise.resolve({ ExitCode: 0 }),
        }),
    });
    await runner.startRun(PROJECT);

    answer({ id: "container" });
    await adopting;

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  /** A run whose exec Docker still reports as alive is mid-flight: installing,
   *  building, or a command that never listens at all. Nothing listening is
   *  what that looks like, and mistaking it for a run that has vanished would
   *  restart every project during its own `npm install`. */
  it("leaves a run that is still starting alone", async () => {
    getRunningContainer.mockResolvedValue({ id: "container" });
    // Nothing bound, as during an install.
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");
    liveExecContainer();
    await runner.startRun(PROJECT);

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  /** The ready probe gives up after a few minutes, so a dev server slower than
   *  that used to be stuck at "starting" for as long as it ran. Opening the
   *  project is a second chance to notice it came up. */
  it("promotes its own run once the port answers", async () => {
    await devServerListening();
    containerReports("9999");
    liveExecContainer();
    await runner.startRun(PROJECT);
    // The ready probe runs on a one-second timer and does not get a turn here.

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("running");
    // Its own history, not a "reconnected to a dev server" notice for a run it
    // never lost.
    expect(runner.getRunHistory(PROJECT).join("")).not.toContain("Reconnected");
  });
});

/** End to end, against the runner rather than the rules: this is the state the
 *  live server was found in — `running`, with nothing in the container and
 *  nothing answering the port. */
describe("a run wedged at running with nothing behind it", () => {
  async function wedge(): Promise<void> {
    await devServerListening();
    containerReports("4242");
    await runner.reconcileRun(PROJECT);
    expect(runner.getRunState(PROJECT).status).toBe("running");

    // The dev server goes away without the exec stream ever ending, taking its
    // process group with it.
    await new Promise<void>((resolve) => {
      devServer?.close(() => resolve());
    });
    devServer = undefined;
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");
    containerReports(undefined);
  }

  it("goes back to idle instead of reporting a dev server that is gone", async () => {
    await wedge();

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  /** The point of going back to idle rather than exited: `autoStartRun` acts on
   *  idle, so opening the project brings the dev server back by itself. Before
   *  this, `running` blocked both the adoption and the start, and only
   *  Stop-then-Run cleared it. */
  it("lets opening the project start it again", async () => {
    await wedge();
    await runner.reconcileRun(PROJECT);

    await runner.autoStartRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("starting");
  });

  /** The exact shape found on the live server: this process started the run, so
   *  it still holds the exec — but the stream never ended, so nothing recorded
   *  the exit. Holding the exec is not evidence of life; only Docker knows. */
  it("asks Docker rather than trusting the exec it is holding", async () => {
    let processAlive = true;
    containerReports(undefined);
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");
    ensureContainer.mockResolvedValue({
      exec: (options: { Cmd: string[] }) => {
        commands.push(options.Cmd);
        return Promise.resolve({
          // Never ends, which is why the exit was never recorded.
          start: () => Promise.resolve(new PassThrough()),
          inspect: () => Promise.resolve({ Running: processAlive }),
        });
      },
    });
    await runner.startRun(PROJECT);
    expect(runner.getRunState(PROJECT).status).toBe("starting");

    processAlive = false;
    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  it("says what happened rather than changing the badge in silence", async () => {
    await wedge();

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain(
      "no longer running",
    );
  });
});

/** A process group id left behind by a run that has since finished names a pid
 *  the kernel is free to hand to something else. Signalling it would kill a
 *  stranger, so the container only reports one it can still see. */
describe("a stale process group record", () => {
  it("still adopts the run, since something is plainly serving", async () => {
    await devServerListening();
    containerReports(undefined);

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  it("says Stop will not work rather than letting it look broken", async () => {
    await devServerListening();
    containerReports(undefined);

    await runner.reconcileRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain(
      "Stop cannot signal",
    );
  });

  /** Named rather than counted: an adopted run also opens a follower on its
   *  recording, so "issued no commands at all" stopped being the same claim as
   *  "signalled nobody". Signalling a pid the kernel has handed to something
   *  else is the thing that must not happen. */
  it("signals nothing when stopped", async () => {
    await devServerListening();
    containerReports(undefined);
    await runner.reconcileRun(PROJECT);

    await runner.stopRun(PROJECT);

    expect(commands.filter((argv) => argv.join(" ").includes("kill"))).toEqual(
      [],
    );
  });
});

describe("parsePgidReport", () => {
  it("reads the id out of the marker line", () => {
    expect(runner.parsePgidReport(`${runner.PGID_MARKER}17\n`)).toBe("17");
  });

  it("is undefined when the container reported nothing", () => {
    expect(runner.parsePgidReport("")).toBeUndefined();
  });

  /** The marker is matched, not the digits, so a number on some other line of
   *  output is not mistaken for a process group. */
  it("ignores digits that are not behind the marker", () => {
    expect(runner.parsePgidReport("4242\n")).toBeUndefined();
  });
});
