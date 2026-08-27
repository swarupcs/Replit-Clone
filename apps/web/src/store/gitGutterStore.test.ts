import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getGitDiffApi } = vi.hoisted(() => ({ getGitDiffApi: vi.fn() }));
vi.mock("../apis/projects.ts", () => ({ getGitDiffApi }));

const { useGitGutterStore, selectRegions } = await import("./gitGutterStore.ts");

const patch =
  "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n";

describe("the git gutter store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getGitDiffApi.mockReset();
    useGitGutterStore.getState().setProject("p1");
  });

  afterEach(() => {
    // Left on, a fake clock leaks into every test that runs after this file.
    vi.useRealTimers();
  });

  it("does not ask on every keystroke", async () => {
    const store = useGitGutterStore.getState();
    getGitDiffApi.mockResolvedValue(patch);

    store.refresh("f.ts");
    store.refresh("f.ts");
    store.refresh("f.ts");
    expect(getGitDiffApi).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(getGitDiffApi).toHaveBeenCalledTimes(1);
  });

  it("turns the patch into regions", async () => {
    getGitDiffApi.mockResolvedValue(patch);

    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    expect(selectRegions("f.ts")(useGitGutterStore.getState())).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
    ]);
  });

  /** Not a repository, a file git has never seen, a container that is not
   *  running: all ordinary, and all mean "no bars" rather than an error put
   *  in front of anyone. */
  it("shows no bars rather than failing when git has nothing to say", async () => {
    getGitDiffApi.mockRejectedValue(new Error("not a git repository"));

    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    expect(selectRegions("f.ts")(useGitGutterStore.getState())).toEqual([]);
  });

  /** The failure this guards is subtle: a slow response for an old edit
   *  landing after a fast one for a newer edit, leaving the margin showing
   *  a diff the file has already moved past. */
  it("ignores a slow answer that a newer request has overtaken", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    getGitDiffApi.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    // A second edit, answered promptly.
    getGitDiffApi.mockResolvedValueOnce(patch);
    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    // Only now does the first one come back, with a stale answer.
    resolveFirst?.(
      "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,9 +1,9 @@\n a\n-x\n+y\n b\n",
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(selectRegions("f.ts")(useGitGutterStore.getState())).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
    ]);
  });

  it("says nothing without a project", async () => {
    useGitGutterStore.getState().setProject(null);
    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    expect(getGitDiffApi).not.toHaveBeenCalled();
  });

  it("drops everything when the project changes", async () => {
    getGitDiffApi.mockResolvedValue(patch);
    useGitGutterStore.getState().refresh("f.ts");
    await vi.advanceTimersByTimeAsync(500);

    useGitGutterStore.getState().setProject("p2");
    expect(useGitGutterStore.getState().regionsByPath).toEqual({});
  });

  it("cancels a pending request when the project changes", async () => {
    getGitDiffApi.mockResolvedValue(patch);
    useGitGutterStore.getState().refresh("f.ts");
    useGitGutterStore.getState().setProject("p2");

    await vi.advanceTimersByTimeAsync(500);
    expect(getGitDiffApi).not.toHaveBeenCalled();
  });

  it("returns the same empty array for a file it knows nothing about", () => {
    const state = useGitGutterStore.getState();
    // A fresh array each call would re-render every subscriber on every
    // unrelated change to the map.
    expect(selectRegions("unknown.ts")(state)).toBe(selectRegions("other.ts")(state));
  });
});
