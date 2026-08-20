import { beforeEach, describe, expect, it } from "vitest";
import { selectActiveTab, useOpenTabsStore } from "./openTabsStore.ts";

const store = () => useOpenTabsStore.getState();

function openAll(...paths: string[]): void {
  for (const relPath of paths) store().openTab(relPath, `// ${relPath}`);
}

function openPaths(): string[] {
  return store().tabs.map((tab) => tab.relPath);
}

beforeEach(() => {
  useOpenTabsStore.setState({ tabs: [], activeRelPath: null });
});

describe("openTab", () => {
  it("appends and focuses a new tab", () => {
    openAll("a.ts", "b.ts");

    expect(openPaths()).toEqual(["a.ts", "b.ts"]);
    expect(store().activeRelPath).toBe("b.ts");
  });

  it("derives name and extension from the path", () => {
    openAll("src/deep/App.tsx");
    const tab = store().tabs[0];

    expect(tab?.name).toBe("App.tsx");
    expect(tab?.extension).toBe("tsx");
  });

  it("leaves an extensionless file without one", () => {
    openAll("Dockerfile");
    expect(store().tabs[0]?.extension).toBeUndefined();
  });

  it("refreshes an already-open file in place rather than duplicating it", () => {
    openAll("a.ts", "b.ts");
    store().markDirty("a.ts", true);
    store().openTab("a.ts", "fresh contents");

    expect(openPaths()).toEqual(["a.ts", "b.ts"]);
    expect(store().activeRelPath).toBe("a.ts");
    expect(store().tabs[0]?.value).toBe("fresh contents");
    expect(store().tabs[0]?.isDirty).toBe(false);
  });
});

describe("closeTab", () => {
  it("focuses the neighbour on the left", () => {
    openAll("a.ts", "b.ts", "c.ts");
    store().setActive("b.ts");
    store().closeTab("b.ts");

    expect(openPaths()).toEqual(["a.ts", "c.ts"]);
    expect(store().activeRelPath).toBe("a.ts");
  });

  it("focuses the new first tab when the leftmost one closes", () => {
    openAll("a.ts", "b.ts");
    store().setActive("a.ts");
    store().closeTab("a.ts");

    expect(store().activeRelPath).toBe("b.ts");
  });

  it("leaves focus alone when closing a tab that was not active", () => {
    openAll("a.ts", "b.ts", "c.ts");
    store().setActive("c.ts");
    store().closeTab("a.ts");

    expect(store().activeRelPath).toBe("c.ts");
  });

  it("clears focus when the last tab closes", () => {
    openAll("a.ts");
    store().closeTab("a.ts");

    expect(openPaths()).toEqual([]);
    expect(store().activeRelPath).toBeNull();
    expect(selectActiveTab(store())).toBeNull();
  });
});

describe("renameTab", () => {
  it("moves the tab and follows it with focus", () => {
    openAll("old.ts");
    store().renameTab("old.ts", "src/new.tsx");

    const tab = store().tabs[0];
    expect(tab?.relPath).toBe("src/new.tsx");
    expect(tab?.name).toBe("new.tsx");
    expect(tab?.extension).toBe("tsx");
    expect(store().activeRelPath).toBe("src/new.tsx");
  });

  it("does not move focus when an inactive tab is renamed", () => {
    openAll("a.ts", "b.ts");
    store().renameTab("a.ts", "renamed.ts");

    expect(store().activeRelPath).toBe("b.ts");
  });
});

describe("selectActiveTab", () => {
  it("returns the focused tab", () => {
    openAll("a.ts", "b.ts");
    expect(selectActiveTab(store())?.relPath).toBe("b.ts");
  });
});
