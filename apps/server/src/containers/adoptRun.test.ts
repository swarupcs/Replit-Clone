import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A dev server outlives the server process that started it. These pin down
 *  what happens when the two disagree — which is every restart, and therefore
 *  every reload of the page afterwards. */

const ensureContainer = vi.fn();
const getRunningContainer = vi.fn();
const getPreviewTarget = vi.fn<() => Promise<string | undefined>>();
const execCapture =
  vi.fn<() => Promise<{ stdout: string; stderr: string; exitCode: number }>>();

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getRunningContainer: (projectId: string): unknown =>
    getRunningContainer(projectId),
  getPreviewTarget: (): unknown => getPreviewTarget(),
}));

vi.mock("./execCapture.js", () => ({
  execCapture: (): unknown => execCapture(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

let runner: typeof import("./runner.js");

/** A real listener, because "is a dev server up" is answered by connecting to
 *  one. Stubbing that away would leave the probe itself untested. */
let devServer: net.Server | undefined;

async function devServerListening(): Promise<void> {
  devServer = net.createServer();
  await new Promise<void>((resolve) => {
    devServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = devServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  getPreviewTarget.mockResolvedValue(`http://127.0.0.1:${String(port)}`);
}

/** What the container says when asked for the process group it recorded. */
function containerReports(pgid: string | undefined): void {
  getRunningContainer.mockResolvedValue({ id: "container" });
  execCapture.mockResolvedValue({
    stdout: pgid === undefined ? "" : `${runner.PGID_MARKER}${pgid}\n`,
    stderr: "",
    exitCode: 0,
  });
}

/** Every command handed to the container, which is how a stop is observed: it
 *  signals a process group and reports nothing else. */
let commands: string[][] = [];

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

    await runner.adoptRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  it("reports the command it is running, so the UI is not blank", async () => {
    await devServerListening();
    containerReports("4242");

    await runner.adoptRun(PROJECT);

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

    await runner.adoptRun(PROJECT);
    release();

    expect(events).toContain("ready");
  });

  it("can be stopped, because it recovers the process group", async () => {
    await devServerListening();
    containerReports("4242");
    await runner.adoptRun(PROJECT);

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
    await runner.adoptRun(PROJECT);

    await runner.autoStartRun(PROJECT);

    expect(ensureContainer).not.toHaveBeenCalled();
    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  it("says the earlier output is gone rather than showing an empty log", async () => {
    await devServerListening();
    containerReports("4242");

    await runner.adoptRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain("not available");
  });
});

describe("when there is nothing to adopt", () => {
  it("leaves a project with no container alone", async () => {
    await devServerListening();
    getRunningContainer.mockResolvedValue(undefined);

    await runner.adoptRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("idle");
  });

  /** A container is up long before its dev server has bound a port — `npm
   *  install` alone takes a while. Adopting on the container's existence would
   *  report `running` for a project that serves nothing. */
  it("leaves a container whose dev server is not listening alone", async () => {
    containerReports("4242");
    // Nothing is bound here, so the probe's connection is refused.
    getPreviewTarget.mockResolvedValue("http://127.0.0.1:1");

    await runner.adoptRun(PROJECT);

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
    const adopting = runner.adoptRun(PROJECT);

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

  it("does not disturb a run this process is already watching", async () => {
    await devServerListening();
    containerReports("9999");
    ensureContainer.mockResolvedValue({
      exec: () =>
        Promise.resolve({
          start: () => Promise.resolve(new PassThrough()),
          inspect: () => Promise.resolve({ ExitCode: 0 }),
        }),
    });
    await runner.startRun(PROJECT);
    const before = runner.getRunState(PROJECT).status;

    await runner.adoptRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe(before);
    expect(execCapture).not.toHaveBeenCalled();
  });
});

/** A process group id left behind by a run that has since finished names a pid
 *  the kernel is free to hand to something else. Signalling it would kill a
 *  stranger, so the container only reports one it can still see. */
describe("a stale process group record", () => {
  it("still adopts the run, since something is plainly serving", async () => {
    await devServerListening();
    containerReports(undefined);

    await runner.adoptRun(PROJECT);

    expect(runner.getRunState(PROJECT).status).toBe("running");
  });

  it("says Stop will not work rather than letting it look broken", async () => {
    await devServerListening();
    containerReports(undefined);

    await runner.adoptRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain(
      "Stop cannot signal",
    );
  });

  it("signals nothing when stopped", async () => {
    await devServerListening();
    containerReports(undefined);
    await runner.adoptRun(PROJECT);

    await runner.stopRun(PROJECT);

    expect(commands).toEqual([]);
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
