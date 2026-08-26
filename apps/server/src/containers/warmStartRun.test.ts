import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** That the decision is wired to the command actually run.
 *
 *  `warmStart.test.ts` covers the decision itself, which is pure. This covers
 *  the other half: that a decision to skip reaches the exec, and that a
 *  decision not to leaves the command exactly as the template wrote it. Only
 *  the three I/O calls are stubbed — `planStart` is the real one, because
 *  stubbing the thing under test would prove nothing.
 */

const ensureContainer = vi.fn();

vi.mock("./containerManager.js", () => ({
  ensureContainer: (projectId: string): unknown => ensureContainer(projectId),
  getPreviewTarget: (): unknown => undefined,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: () => Promise.resolve({ template: "react-vite" }) },
  },
}));

const readStamp = vi.fn();
const dependencyFingerprint = vi.fn();
const installArtefactsPresent = vi.fn();
const writeStamp = vi.fn((): Promise<void> => Promise.resolve());

vi.mock("./warmStart.js", async () => {
  const actual = await vi.importActual<typeof import("./warmStart.js")>(
    "./warmStart.js",
  );
  return {
    ...actual,
    readStamp: (): unknown => readStamp(),
    dependencyFingerprint: (): unknown => dependencyFingerprint(),
    installArtefactsPresent: (): unknown => installArtefactsPresent(),
    writeStamp: (): unknown => writeStamp(),
  };
});

const PROJECT = "3f2b91ac-7d4e-4c18-9a05-6e8b1d2c4f77";
const FINGERPRINT = "a".repeat(64);

let runner: typeof import("./runner.js");
let commands: string[][] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  commands = [];

  ensureContainer.mockResolvedValue({
    exec: (options: { Cmd: string[] }) => {
      commands.push(options.Cmd);
      return Promise.resolve({
        start: () => Promise.resolve(new PassThrough()),
        inspect: () => Promise.resolve({ ExitCode: 0 }),
      });
    },
  });

  runner = await import("./runner.js");
  runner.forgetRun(PROJECT);
});

/** The command the run itself was started with, found by the marker the
 *  launcher prints rather than by position. */
function runCommand(): string {
  return (
    commands
      .find((argv) => argv.join(" ").includes(runner.PGID_MARKER))
      ?.join(" ") ?? ""
  );
}

describe("starting a project whose dependencies have not changed", () => {
  it("leaves the install out", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(FINGERPRINT);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    expect(runCommand()).toContain("npm run dev");
    expect(runCommand()).not.toContain("npm install");
  });

  it("says so in the run output, rather than quietly doing less", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(FINGERPRINT);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    expect(runner.getRunHistory(PROJECT).join("")).toContain(
      "skipping it",
    );
  });

  it("reports the command it really ran, not the one it was given", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(FINGERPRINT);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    // The status bar shows this. Showing the full command would describe work
    // that did not happen.
    expect(runner.getRunState(PROJECT).command).toBe("npm run dev");
  });
});

describe("starting a project whose dependencies may have changed", () => {
  it("installs when nothing has been stamped", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(null);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    expect(runCommand()).toContain("npm install");
  });

  it("installs when the fingerprint moved", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue("b".repeat(64));
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    expect(runCommand()).toContain("npm install");
  });

  it("installs when node_modules is gone", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(FINGERPRINT);
    installArtefactsPresent.mockResolvedValue(false);

    await runner.startRun(PROJECT);

    expect(runCommand()).toContain("npm install");
  });

  it("installs when the fingerprint cannot be taken at all", async () => {
    // Reading the tree failed. Erring towards installing is the whole point.
    dependencyFingerprint.mockRejectedValue(new Error("no"));
    readStamp.mockResolvedValue(FINGERPRINT);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    expect(runCommand()).toContain("npm install");
  });

  it("does not stamp anything before the run has proved itself", async () => {
    dependencyFingerprint.mockResolvedValue(FINGERPRINT);
    readStamp.mockResolvedValue(null);
    installArtefactsPresent.mockResolvedValue(true);

    await runner.startRun(PROJECT);

    // Only readiness proves both that the install worked and that what it
    // produced can boot.
    expect(writeStamp).not.toHaveBeenCalled();
  });
});
