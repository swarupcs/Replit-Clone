import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore, type WorkspaceSession } from "./workspaceStore.ts";

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

/** The bug that broke opening a project outright.
 *
 *  `merge` took a Partial and cast the result to a full WorkspaceSession, so
 *  the FIRST thing written for a project decided its shape. Toggling a panel
 *  or dragging a divider before any file was opened stored a session with no
 *  `openPaths` and no `expandedPaths` — and on the next load the restore read
 *  `session.expandedPaths`, handed undefined to setExpandedPaths, and threw
 *  "Cannot read properties of undefined (reading 'length')" out of an effect
 *  in ProjectPlayground, which is above every panel-level boundary. The whole
 *  page became "Something broke".
 */
describe("a session built one field at a time", () => {
  it.each([
    ["a panel toggle", { showSidebar: false }],
    ["a divider drag", { sidebarWidth: 300 }],
    ["a preview toggle", { showPreview: true }],
  ])("is still complete after only %s", (_label, patch) => {
    store().merge("p1", patch);

    const session = store().get("p1");
    expect(session?.openPaths).toEqual([]);
    expect(session?.expandedPaths).toEqual([]);
    expect(session?.activeRelPath).toBeNull();
  });

  it("never yields a session the restore cannot iterate", () => {
    store().merge("p1", { panelHeight: 420 });
    const session = store().get("p1");

    // Exactly what useWorkspaceSession does with it.
    expect(() => session?.expandedPaths.length).not.toThrow();
    expect(() => session?.openPaths.filter(Boolean)).not.toThrow();
  });
});

/** Sessions written by the buggy version are already in people's browsers, so
 *  reading has to repair them too — a fix that only guards new writes leaves
 *  every affected user crashing on the project they were last in. */
describe("reading a session stored by an older build", () => {
  it("fills in fields that were never written", () => {
    useWorkspaceStore.setState({
      sessions: { p1: { sidebarWidth: 260 } as unknown as WorkspaceSession },
    });

    const session = store().get("p1");
    expect(session?.openPaths).toEqual([]);
    expect(session?.expandedPaths).toEqual([]);
    expect(session?.activeRelPath).toBeNull();
    // And keeps what WAS stored.
    expect(session?.sidebarWidth).toBe(260);
  });

  it.each([
    ["null", null],
    ["a string", "a.ts"],
    ["an object", {}],
  ])("replaces a path list stored as %s", (_label, bogus) => {
    useWorkspaceStore.setState({
      sessions: {
        p1: {
          openPaths: bogus,
          expandedPaths: bogus,
          activeRelPath: null,
        } as unknown as WorkspaceSession,
      },
    });

    const session = store().get("p1");
    expect(session?.openPaths).toEqual([]);
    expect(session?.expandedPaths).toEqual([]);
  });

  it("still reports nothing for a project it has never seen", () => {
    expect(store().get("never-opened")).toBeUndefined();
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
