import { beforeEach, describe, expect, it, vi } from "vitest";

/** Doing the install before somebody is waiting for it.
 *
 *  plan.md §12.2. The failure direction is the whole subject. A prebuild that
 *  does not happen costs a minute somebody was going to spend anyway; a
 *  prebuild that stamps an install it did not do makes the next start serve
 *  against dependencies that are not there, silently, and `warmStart`'s entire
 *  design note is about never doing that. So every test below is about when
 *  the stamp is NOT written.
 */

const projectFindUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique: projectFindUnique } },
}));

const getRunningContainer = vi.hoisted(() => vi.fn());
const runningProjectContainers = vi.hoisted(() => vi.fn());
vi.mock("./containerManager.js", () => ({
  getRunningContainer,
  runningProjectContainers,
}));

const execCapture = vi.hoisted(() => vi.fn());
vi.mock("./execCapture.js", () => ({ execCapture }));

const dependencyFingerprint = vi.hoisted(() => vi.fn());
const installArtefactsPresent = vi.hoisted(() => vi.fn());
const readStamp = vi.hoisted(() => vi.fn());
const writeStamp = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./warmStart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./warmStart.js")>();
  // `splitStartCommand` is deliberately the real one. Its allowlist is what
  // stands between this and running the SERVE half of somebody's command in
  // the background, and a mock of it would test nothing.
  return {
    ...actual,
    dependencyFingerprint,
    installArtefactsPresent,
    readStamp,
    writeStamp,
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { installStepFor, needsPrebuild, prebuild, sweepPrebuilds } from "./prebuild.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONTAINER = { id: "c1" } as never;
const HASH = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  projectFindUnique.mockResolvedValue({
    template: "react-vite",
    startCommand: null,
    deletedAt: null,
    takenDownAt: null,
  });
  getRunningContainer.mockResolvedValue(CONTAINER);
  runningProjectContainers.mockResolvedValue([PROJECT]);
  execCapture.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  dependencyFingerprint.mockResolvedValue(HASH);
  installArtefactsPresent.mockResolvedValue(true);
  // Stamped against something else, so there is work to do.
  readStamp.mockResolvedValue("b".repeat(64));
  writeStamp.mockResolvedValue(undefined);
});

describe("whether there is anything to do", () => {
  it("is yes when the dependencies have moved since the last install", async () => {
    expect(await needsPrebuild(PROJECT, CONTAINER)).toBe(true);
  });

  it("is no when they have not", async () => {
    readStamp.mockResolvedValue(HASH);

    expect(await needsPrebuild(PROJECT, CONTAINER)).toBe(false);
  });

  /** A static template declares nothing to install, and a prebuild that ran
   *  anyway would be a loop doing nothing for ever. */
  it("is no for a project with no dependency files at all", async () => {
    dependencyFingerprint.mockResolvedValue(null);

    expect(await needsPrebuild(PROJECT, CONTAINER)).toBe(false);
  });

  /** Deleting `node_modules` is a thing people do meaning it, and the next
   *  start would install however well the stamp matched. */
  it("is yes when the stamp matches but the artefacts are gone", async () => {
    readStamp.mockResolvedValue(HASH);
    installArtefactsPresent.mockResolvedValue(false);

    expect(await needsPrebuild(PROJECT, CONTAINER)).toBe(true);
  });
});

describe("which command it would run", () => {
  it("is the install half of the template's, and only that half", async () => {
    const install = await installStepFor(PROJECT);

    expect(install).toMatch(/install/);
    expect(install).not.toMatch(/dev|serve|run /);
  });

  it("is the project's own command when it has one", async () => {
    projectFindUnique.mockResolvedValue({
      template: "react-vite",
      startCommand: "npm ci && npm start",
      deletedAt: null,
      takenDownAt: null,
    });

    expect(await installStepFor(PROJECT)).toBe("npm ci");
  });

  /** The load-bearing refusal. A command this cannot take apart with certainty
   *  must not be run in the background — the half that would run is somebody's
   *  server. */
  it("is nothing for a command it cannot take apart", async () => {
    projectFindUnique.mockResolvedValue({
      template: "react-vite",
      startCommand: "./deploy.sh && npm start",
      deletedAt: null,
      takenDownAt: null,
    });

    expect(await installStepFor(PROJECT)).toBeNull();
  });

  it("is nothing for a project in the trash", async () => {
    projectFindUnique.mockResolvedValue({
      template: "react-vite",
      startCommand: null,
      deletedAt: new Date(),
      takenDownAt: null,
    });

    expect(await installStepFor(PROJECT)).toBeNull();
  });

  it("is nothing for a project under a takedown", async () => {
    projectFindUnique.mockResolvedValue({
      template: "react-vite",
      startCommand: null,
      deletedAt: null,
      takenDownAt: new Date(),
    });

    expect(await installStepFor(PROJECT)).toBeNull();
  });
});

describe("running one", () => {
  it("installs and stamps what it installed against", async () => {
    expect(await prebuild(PROJECT)).toBe(true);

    expect(execCapture).toHaveBeenCalledWith(
      CONTAINER,
      expect.arrayContaining(["sh", "-lc"]),
    );
    expect(writeStamp).toHaveBeenCalledWith(CONTAINER, HASH);
  });

  /** Starting a stopped container is §12.5 and is a decision, not a line of
   *  code. Until it is taken, a stopped workspace is left alone. */
  it("does nothing for a workspace that is not running", async () => {
    getRunningContainer.mockResolvedValue(undefined);

    expect(await prebuild(PROJECT)).toBe(false);
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("does nothing when the dependencies have not moved", async () => {
    readStamp.mockResolvedValue(HASH);

    expect(await prebuild(PROJECT)).toBe(false);
    expect(execCapture).not.toHaveBeenCalled();
  });

  /** The one that would actually hurt: a stamp claiming an install that did
   *  not succeed makes the next start skip installing and serve against
   *  dependencies that are not there. */
  it("does not stamp an install that failed", async () => {
    execCapture.mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 1 });

    expect(await prebuild(PROJECT)).toBe(false);
    expect(writeStamp).not.toHaveBeenCalled();
  });

  it("does not stamp when the install threw", async () => {
    execCapture.mockRejectedValue(new Error("daemon gone"));

    expect(await prebuild(PROJECT)).toBe(false);
    expect(writeStamp).not.toHaveBeenCalled();
  });

  /** An install takes minutes and a lockfile can move underneath it. Stamping
   *  the fingerprint read before the run would claim an install that never
   *  happened for the files as they now stand. */
  it("does not stamp when the dependencies moved while it was installing", async () => {
    dependencyFingerprint
      .mockResolvedValueOnce(HASH) // the decision
      .mockResolvedValueOnce(HASH) // read before the run
      .mockResolvedValueOnce("c".repeat(64)); // read after it

    expect(await prebuild(PROJECT)).toBe(false);
    expect(writeStamp).not.toHaveBeenCalled();
  });

  /** Never throws, whatever happens. Nothing is waiting on it, and an
   *  unhandled rejection from a background timer takes the process with it. */
  it("does not throw when everything fails at once", async () => {
    getRunningContainer.mockRejectedValue(new Error("no daemon"));

    await expect(prebuild(PROJECT)).resolves.toBe(false);
  });
});

describe("the sweep", () => {
  it("considers every running workspace", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, OTHER]);

    expect(await sweepPrebuilds()).toBe(2);
  });

  it("counts only the ones that actually installed", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, OTHER]);
    readStamp.mockResolvedValueOnce("b".repeat(64)).mockResolvedValueOnce(HASH);

    expect(await sweepPrebuilds()).toBe(1);
  });

  /** An install is the most expensive thing this server causes to happen, and
   *  the premise is that it runs while the machine is quiet. Several at once
   *  would be a background task that makes the foreground slower. */
  it("runs them one at a time", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, OTHER]);

    let inFlight = 0;
    let peak = 0;
    execCapture.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await sweepPrebuilds();

    expect(peak).toBe(1);
  });

  it("carries on past a workspace it cannot build", async () => {
    runningProjectContainers.mockResolvedValue([PROJECT, OTHER]);
    getRunningContainer.mockRejectedValueOnce(new Error("gone"));

    expect(await sweepPrebuilds()).toBe(1);
  });
});
