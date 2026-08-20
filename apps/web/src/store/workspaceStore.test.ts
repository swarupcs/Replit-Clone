import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "./workspaceStore.ts";

const store = () => useWorkspaceStore.getState();

beforeEach(() => {
  useWorkspaceStore.setState({ sessions: {} });
});

describe("workspace sessions", () => {
  it("has nothing for a project never opened", () => {
    expect(store().get("p1")).toBeUndefined();
  });

  it("remembers what was open", () => {
    store().merge("p1", { openPaths: ["a.ts"], activeRelPath: "a.ts" });

    expect(store().get("p1")?.openPaths).toEqual(["a.ts"]);
    expect(store().get("p1")?.activeRelPath).toBe("a.ts");
  });

  it("merges rather than replacing, so one field does not erase another", () => {
    store().merge("p1", { openPaths: ["a.ts"], activeRelPath: "a.ts" });
    store().merge("p1", { sidebarWidth: 300 });

    const session = store().get("p1");
    expect(session?.openPaths).toEqual(["a.ts"]);
    expect(session?.sidebarWidth).toBe(300);
  });

  it("keeps projects apart", () => {
    store().merge("p1", { openPaths: ["a.ts"] });
    store().merge("p2", { openPaths: ["b.ts"] });

    expect(store().get("p1")?.openPaths).toEqual(["a.ts"]);
    expect(store().get("p2")?.openPaths).toEqual(["b.ts"]);
  });

  it("forgets a project on request", () => {
    store().merge("p1", { openPaths: ["a.ts"] });
    store().forget("p1");

    expect(store().get("p1")).toBeUndefined();
  });

  it("caps how many projects it remembers", () => {
    // Otherwise this grows for the life of the browser profile.
    for (let i = 0; i < 40; i += 1) {
      store().merge(`p${String(i)}`, { openPaths: [`${String(i)}.ts`] });
    }

    expect(Object.keys(store().sessions).length).toBeLessThanOrEqual(25);
    // The most recent survive; the oldest are dropped.
    expect(store().get("p39")).toBeDefined();
    expect(store().get("p0")).toBeUndefined();
  });

  it("records an explicitly empty tab list", () => {
    // Closing every tab is a real arrangement, not a reason to forget.
    store().merge("p1", { openPaths: ["a.ts"] });
    store().merge("p1", { openPaths: [], activeRelPath: null });

    expect(store().get("p1")?.openPaths).toEqual([]);
  });
});

describe("persistence", () => {
  it("writes through to storage, so a reload can read it back", async () => {
    store().merge("p1", { openPaths: ["a.ts"], sidebarWidth: 320 });

    // zustand's persist defers the write to a microtask, so reading in the
    // same tick sees nothing.
    await Promise.resolve();

    const raw = localStorage.getItem("rc-workspace");
    expect(raw).not.toBeNull();
    expect(raw).toContain("a.ts");
    expect(raw).toContain("320");
  });
});
