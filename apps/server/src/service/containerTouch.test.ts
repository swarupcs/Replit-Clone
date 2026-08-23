import { beforeEach, describe, expect, it, vi } from "vitest";

const execCapture = vi.hoisted(() => vi.fn());
const getRunningContainer = vi.hoisted(() => vi.fn());

vi.mock("../containers/execCapture.js", () => ({ execCapture }));
vi.mock("../containers/containerManager.js", () => ({
  getRunningContainer,
}));
vi.mock("../config/env.js", () => ({ watchPolling: true }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  extendLogContext: vi.fn(),
}));

import { touchFilesInContainer } from "./containerTouch.js";
import { resetTouchEchoes, withoutOurOwnTouches } from "./touchEcho.js";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  vi.clearAllMocks();
  resetTouchEchoes();
  getRunningContainer.mockResolvedValue({ id: "container" });
});

describe("touchFilesInContainer", () => {
  it("touches exactly the changed files, once", async () => {
    await touchFilesInContainer(PROJECT, ["src/App.tsx", "index.html"]);

    expect(execCapture).toHaveBeenCalledTimes(1);
    expect(execCapture.mock.calls[0]?.[1]).toEqual([
      "touch",
      "-c",
      "src/App.tsx",
      "index.html",
    ]);
  });

  /** A plain touch would resurrect a file the user just deleted — the
   *  watcher's window holds unlinks alongside writes. */
  it("uses -c so deletions are not resurrected", async () => {
    await touchFilesInContainer(PROJECT, ["gone.txt"]);

    expect(execCapture.mock.calls[0]?.[1]).toContain("-c");
  });

  it("does nothing without a running container", async () => {
    getRunningContainer.mockResolvedValue(undefined);

    await touchFilesInContainer(PROJECT, ["src/App.tsx"]);

    expect(execCapture).not.toHaveBeenCalled();
  });

  it("drops duplicates and path-traversal-looking entries", async () => {
    await touchFilesInContainer(PROJECT, [
      "a.txt",
      "a.txt",
      "../escape.txt",
      "/etc/passwd",
      "",
    ]);

    expect(execCapture.mock.calls[0]?.[1]).toEqual(["touch", "-c", "a.txt"]);
  });

  it("never execs for an empty change list", async () => {
    await touchFilesInContainer(PROJECT, []);

    expect(execCapture).not.toHaveBeenCalled();
  });

  /** One exec argv is bounded; a build that rewrote the world must not make
   *  one that the daemon refuses. */
  it("caps the file list per exec", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `file-${String(i)}.txt`);

    await touchFilesInContainer(PROJECT, many);

    const argv = execCapture.mock.calls[0]?.[1];
    expect(argv).toHaveLength(202); // touch -c + 200 files
  });

  it("swallows failures — the touch is best effort", async () => {
    execCapture.mockRejectedValue(new Error("docker daemon gone"));

    await expect(
      touchFilesInContainer(PROJECT, ["src/App.tsx"]),
    ).resolves.toBeUndefined();
  });
});

/** The touch lands on the HOST file too — the bind mount carries it both ways
 *  even though inotify only crosses one — so the server's own watcher reports
 *  it as a change moments later. Answering that report by touching again is a
 *  loop with no exit, and it ran: the file tree refetched forever and the
 *  preview iframe remounted faster than the dev server could recompile. */
describe("the echo it is about to cause", () => {
  it("is announced, so the watcher does not act on it", async () => {
    await touchFilesInContainer(PROJECT, ["src/App.tsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["src/App.tsx"])).toEqual([]);
  });

  /** Announced BEFORE the write. The mount can deliver the echo while the exec
   *  is still settling, and an expectation recorded afterwards would arrive
   *  too late to recognise it. */
  it("is announced before the touch is run", async () => {
    let expectedDuringExec: string[] | undefined;
    execCapture.mockImplementation(() => {
      expectedDuringExec = withoutOurOwnTouches(PROJECT, ["src/App.tsx"]);
      return Promise.resolve("");
    });

    await touchFilesInContainer(PROJECT, ["src/App.tsx"]);

    expect(expectedDuringExec).toEqual([]);
  });

  /** Nothing was written, so nothing will come back. Claiming otherwise would
   *  swallow the user's next save of that file. */
  it("is not announced when there is no container to touch in", async () => {
    getRunningContainer.mockResolvedValue(undefined);

    await touchFilesInContainer(PROJECT, ["src/App.tsx"]);

    expect(withoutOurOwnTouches(PROJECT, ["src/App.tsx"])).toEqual([
      "src/App.tsx",
    ]);
  });
});
