import { beforeEach, describe, expect, it } from "vitest";
import {
  selectActiveTab,
  selectHasUnsavedWork,
  selectPaneTab,
  useOpenTabsStore,
} from "./openTabsStore.ts";

const store = () => useOpenTabsStore.getState();

function openAll(...paths: string[]): void {
  for (const relPath of paths) store().openTab(relPath, `// ${relPath}`);
}

function openPaths(): string[] {
  return store().tabs.map((tab) => tab.relPath);
}

beforeEach(() => {
  useOpenTabsStore.setState({
    tabs: [],
    activeRelPath: null,
    secondaryRelPath: null,
    splitOpen: false,
    focusedPane: "primary",
  });
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

describe("selectHasUnsavedWork", () => {
  it("is false with nothing open", () => {
    expect(selectHasUnsavedWork(store())).toBe(false);
  });

  it("is false while every tab is saved", () => {
    openAll("a.ts", "b.ts");
    expect(selectHasUnsavedWork(store())).toBe(false);
  });

  it("is true as soon as any tab is dirty", () => {
    openAll("a.ts", "b.ts");
    store().markDirty("a.ts", true);

    expect(selectHasUnsavedWork(store())).toBe(true);
  });

  it("clears once the last dirty tab is saved", () => {
    openAll("a.ts", "b.ts");
    store().markDirty("a.ts", true);
    store().markDirty("b.ts", true);

    store().markDirty("a.ts", false);
    expect(selectHasUnsavedWork(store())).toBe(true);

    store().markDirty("b.ts", false);
    expect(selectHasUnsavedWork(store())).toBe(false);
  });

  it("clears when a dirty tab is closed", () => {
    openAll("a.ts");
    store().markDirty("a.ts", true);
    store().closeTab("a.ts");

    expect(selectHasUnsavedWork(store())).toBe(false);
  });
});

describe("split panes", () => {
  it("starts with a single pane", () => {
    expect(store().splitOpen).toBe(false);
    expect(store().secondaryRelPath).toBeNull();
    expect(store().focusedPane).toBe("primary");
  });

  it("opens a file to the side and focuses it there", () => {
    openAll("a.ts");
    store().openToSide("b.ts");

    expect(store().splitOpen).toBe(true);
    expect(store().secondaryRelPath).toBe("b.ts");
    expect(store().focusedPane).toBe("secondary");
    // The primary keeps what it had.
    expect(store().activeRelPath).toBe("a.ts");
  });

  it("seeds an empty primary rather than leaving a blank pane beside it", () => {
    store().openToSide("b.ts");
    expect(store().activeRelPath).toBe("b.ts");
  });

  it("opens new files into the focused pane", () => {
    openAll("a.ts");
    store().openToSide("b.ts");
    openAll("c.ts");

    expect(store().secondaryRelPath).toBe("c.ts");
    expect(store().activeRelPath).toBe("a.ts");
  });

  it("opens into the primary again once focus returns", () => {
    openAll("a.ts");
    store().openToSide("b.ts");
    store().focusPane("primary");
    openAll("c.ts");

    expect(store().activeRelPath).toBe("c.ts");
    expect(store().secondaryRelPath).toBe("b.ts");
  });

  it("clears both panes when the file they share is closed", () => {
    // A pane left pointing at a closed tab renders nothing at all.
    openAll("a.ts");
    store().openToSide("a.ts");
    store().closeTab("a.ts");

    expect(store().activeRelPath).toBeNull();
    expect(store().secondaryRelPath).toBeNull();
  });

  it("only clears the pane that was showing the closed file", () => {
    openAll("a.ts", "b.ts");
    store().focusPane("primary");
    store().setActive("a.ts");
    store().openToSide("b.ts");

    store().closeTab("b.ts");

    expect(store().activeRelPath).toBe("a.ts");
    expect(store().secondaryRelPath).toBe("a.ts");
  });

  it("follows a rename in whichever pane shows the file", () => {
    openAll("a.ts");
    store().openToSide("a.ts");
    store().renameTab("a.ts", "renamed.ts");

    expect(store().activeRelPath).toBe("renamed.ts");
    expect(store().secondaryRelPath).toBe("renamed.ts");
  });

  it("returns to a single pane on close", () => {
    openAll("a.ts");
    store().openToSide("b.ts");
    store().closeSplit();

    expect(store().splitOpen).toBe(false);
    expect(store().secondaryRelPath).toBeNull();
    expect(store().focusedPane).toBe("primary");
  });

  it("resolves each pane's tab independently", () => {
    openAll("a.ts", "b.ts");
    store().focusPane("primary");
    store().setActive("a.ts");
    store().openToSide("b.ts");

    expect(selectPaneTab("primary")(store())?.relPath).toBe("a.ts");
    expect(selectPaneTab("secondary")(store())?.relPath).toBe("b.ts");
  });
});
