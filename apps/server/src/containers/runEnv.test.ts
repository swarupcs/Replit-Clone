import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The wiring between "this host needs polling" and the process that would do
 *  the polling. The decision itself is pinned in config/fileWatching.test.ts;
 *  what this catches is the decision being made and then not handed on. */

const POLLING = ["WATCHPACK_POLLING=1000", "CHOKIDAR_USEPOLLING=true"];

vi.mock("../config/env.js", () => ({
  env: { AUTO_START_ON_OPEN: true },
  watchPollingEnv: POLLING,
  // Read by the logger, which the runner pulls in.
  isProduction: false,
  PROJECTS_ROOT: "/projects",
  previewTargetMode: "host-loopback",
  watchPolling: true,
}));

const ensureContainer = vi.fn();

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getRunningContainer: () => Promise.resolve(undefined),
  getPreviewTarget: () => Promise.resolve(undefined),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const PROJECT = "7e1c4b02-9a3d-4f18-8b6e-2d5a7c9e0f31";

let runner: typeof import("./runner.js");
let execEnv: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  execEnv = [];
  ensureContainer.mockResolvedValue({
    exec: (options: { Env: string[] }) => {
      execEnv = options.Env;
      return Promise.resolve({
        start: () => Promise.resolve(new PassThrough()),
        inspect: () => Promise.resolve({ ExitCode: 0 }),
      });
    },
  });
  runner = await import("./runner.js");
  runner.forgetRun(PROJECT);
});

describe("the environment a run is started in", () => {
  /** Without this the dev server never learns a file changed, so a save that
   *  reached the container correctly still leaves the preview on the previous
   *  version of the page — which reads as a broken save. */
  it("carries the host's file-watching settings", async () => {
    await runner.startRun(PROJECT);

    for (const entry of POLLING) expect(execEnv).toContain(entry);
  });

  it("still tells the dev server where it is being served from", async () => {
    await runner.startRun(PROJECT);

    expect(execEnv).toContain(`PREVIEW_BASE=/preview/${PROJECT}/`);
  });
});
