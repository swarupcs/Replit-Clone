import { beforeEach, describe, expect, it } from "vitest";
import {
  selectActiveTab,
  selectHasUnsavedWork,
  selectMruTabs,
  selectNextMruTab,
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
    review: null,
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

describe("reviewing a proposed change", () => {
  const offer = {
    id: "p-1",
    relPath: "src/App.tsx",
    summary: "fix the thing",
    contents: "the new file",
  };

  /** The reviewer has to be looking at the file the change is against; the
   *  focused pane may well be showing something else. */
  it("brings the file up in the primary pane", () => {
    openAll("src/App.tsx", "other.ts");
    store().openToSide("other.ts");

    store().startReview(offer);

    expect(store().activeRelPath).toBe("src/App.tsx");
    expect(store().focusedPane).toBe("primary");
  });

  it("ends when it is closed", () => {
    openAll("src/App.tsx");
    store().startReview(offer);

    store().endReview();

    expect(store().review).toBeNull();
  });

  /** A closed file has no buffer, so the diff would be against nothing. */
  it("ends when the file it is against is closed", () => {
    openAll("src/App.tsx", "other.ts");
    store().startReview(offer);

    store().closeTab("src/App.tsx");

    expect(store().review).toBeNull();
  });

  it("survives closing some other file", () => {
    openAll("src/App.tsx", "other.ts");
    store().startReview(offer);

    store().closeTab("other.ts");

    expect(store().review).toMatchObject({ relPath: "src/App.tsx" });
  });

  it("ends when every tab is closed", () => {
    openAll("src/App.tsx");
    store().startReview(offer);

    store().closeAll();

    expect(store().review).toBeNull();
  });
});

describe("preview tabs", () => {
  const open = (relPath: string, options?: { preview?: boolean }) =>
    useOpenTabsStore.getState().openTab(relPath, `// ${relPath}`, options);

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("replaces the previous preview rather than stacking tabs", () => {
    open("a.ts", { preview: true });
    open("b.ts", { preview: true });
    open("c.ts", { preview: true });

    // The complaint this answers: browsing a tree used to leave one tab per
    // file looked at and discarded.
    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "c.ts",
    ]);
  });

  it("replaces in place, keeping the strip's order", () => {
    open("keep.ts");
    open("preview.ts", { preview: true });
    open("last.ts");
    open("swapped.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "keep.ts",
      "swapped.ts",
      "last.ts",
    ]);
  });

  it("keeps a permanent tab beside a preview", () => {
    open("kept.ts");
    open("skimmed.ts", { preview: true });
    open("also-skimmed.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "kept.ts",
      "also-skimmed.ts",
    ]);
  });

  it("promotes on a deliberate open of the file already previewing", () => {
    open("a.ts", { preview: true });
    open("a.ts");
    open("b.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("promotes explicitly, which is what a double click does", () => {
    open("a.ts", { preview: true });
    useOpenTabsStore.getState().promoteTab("a.ts");
    open("b.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs).toHaveLength(2);
  });

  /** Typing into a file is the clearest possible statement that it is not
   *  being skimmed — and replacing it would throw the edit away. */
  it("keeps a preview the moment it is edited", () => {
    open("a.ts", { preview: true });
    useOpenTabsStore.getState().markDirty("a.ts", true);
    open("b.ts", { preview: true });

    const { tabs } = useOpenTabsStore.getState();
    expect(tabs.map((tab) => tab.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(tabs[0]?.isPreview).toBe(false);
  });

  /** Unreachable through `markDirty`, which clears the preview flag as it
   *  sets the dirty one — so this reaches past it to build the state
   *  directly. The clause stays because the cost of the check is nothing and
   *  the cost of being wrong is somebody's unsaved edit. */
  it("refuses to replace a dirty preview however it got that way", () => {
    open("a.ts", { preview: true });
    useOpenTabsStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, isDirty: true })),
    }));
    open("b.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("never replaces a pinned tab", () => {
    open("a.ts", { preview: true });
    useOpenTabsStore.getState().togglePin("a.ts");
    open("b.ts", { preview: true });

    expect(useOpenTabsStore.getState().tabs).toHaveLength(2);
  });
});

describe("pinning", () => {
  const open = (relPath: string) =>
    useOpenTabsStore.getState().openTab(relPath, "");

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("moves a pinned tab left of every unpinned one", () => {
    open("a.ts");
    open("b.ts");
    open("c.ts");
    useOpenTabsStore.getState().togglePin("c.ts");

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "c.ts",
      "a.ts",
      "b.ts",
    ]);
  });

  it("returns it to the unpinned block when unpinned", () => {
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.getState().togglePin("b.ts");
    useOpenTabsStore.getState().togglePin("b.ts");

    const { tabs } = useOpenTabsStore.getState();
    expect(tabs.every((tab) => !tab.isPinned)).toBe(true);
  });

  it("survives close others", () => {
    open("pinned.ts");
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.getState().togglePin("pinned.ts");
    useOpenTabsStore.getState().closeOthers("a.ts");

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "pinned.ts",
      "a.ts",
    ]);
  });
});

describe("reordering", () => {
  const open = (relPath: string) =>
    useOpenTabsStore.getState().openTab(relPath, "");

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("moves a tab to a new index", () => {
    open("a.ts");
    open("b.ts");
    open("c.ts");
    useOpenTabsStore.getState().moveTab("c.ts", 0);

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "c.ts",
      "a.ts",
      "b.ts",
    ]);
  });

  /** A drag across the pinned boundary is a reorder, not a pin — silently
   *  changing a tab's state because it was dropped past a line would be a
   *  surprise nobody asked for. */
  it("does not let a drag past the boundary pin or unpin anything", () => {
    open("pinned.ts");
    open("a.ts");
    useOpenTabsStore.getState().togglePin("pinned.ts");
    useOpenTabsStore.getState().moveTab("a.ts", 0);

    const { tabs } = useOpenTabsStore.getState();
    expect(tabs.map((tab) => tab.relPath)).toEqual(["pinned.ts", "a.ts"]);
    expect(tabs.find((tab) => tab.relPath === "a.ts")?.isPinned).toBe(false);
  });

  it("ignores a move of a tab that is not open", () => {
    open("a.ts");
    useOpenTabsStore.getState().moveTab("gone.ts", 0);
    expect(useOpenTabsStore.getState().tabs).toHaveLength(1);
  });
});

describe("closing in bulk", () => {
  const open = (relPath: string) =>
    useOpenTabsStore.getState().openTab(relPath, "");

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("closes to the right without touching the left", () => {
    open("a.ts");
    open("b.ts");
    open("c.ts");
    useOpenTabsStore.getState().closeToRight("b.ts");

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  /** The worst bug this file could have: a convenience command that throws
   *  away work existing nowhere else. */
  it("keeps unsaved work when closing saved tabs", () => {
    open("clean.ts");
    open("dirty.ts");
    useOpenTabsStore.getState().markDirty("dirty.ts", true);
    useOpenTabsStore.getState().closeSaved();

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "dirty.ts",
    ]);
  });

  it("keeps pinned tabs when closing saved tabs", () => {
    open("clean.ts");
    open("pinned.ts");
    useOpenTabsStore.getState().togglePin("pinned.ts");
    useOpenTabsStore.getState().closeSaved();

    expect(useOpenTabsStore.getState().tabs.map((tab) => tab.relPath)).toEqual([
      "pinned.ts",
    ]);
  });
});

describe("reopening a closed tab", () => {
  const open = (relPath: string) =>
    useOpenTabsStore.getState().openTab(relPath, "");

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("hands back the most recently closed path", () => {
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.getState().closeTab("a.ts");
    useOpenTabsStore.getState().closeTab("b.ts");

    expect(useOpenTabsStore.getState().takeClosed()).toBe("b.ts");
    expect(useOpenTabsStore.getState().takeClosed()).toBe("a.ts");
    expect(useOpenTabsStore.getState().takeClosed()).toBeNull();
  });

  it("skips anything reopened by other means since", () => {
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.getState().closeTab("a.ts");
    useOpenTabsStore.getState().closeTab("b.ts");
    open("b.ts");

    // b is already on screen; handing it back would do nothing visible.
    expect(useOpenTabsStore.getState().takeClosed()).toBe("a.ts");
  });

  it("remembers everything a bulk close removed", () => {
    open("a.ts");
    open("b.ts");
    open("c.ts");
    useOpenTabsStore.getState().closeOthers("a.ts");

    expect(useOpenTabsStore.getState().takeClosed()).toBe("c.ts");
    expect(useOpenTabsStore.getState().takeClosed()).toBe("b.ts");
  });
});

describe("most-recently-used order", () => {
  const open = (relPath: string) =>
    useOpenTabsStore.getState().openTab(relPath, "");

  beforeEach(() => {
    useOpenTabsStore.getState().closeAll();
  });

  it("offers the previously used tab, not the neighbour to the right", () => {
    open("a.ts");
    open("b.ts");
    open("c.ts");
    useOpenTabsStore.getState().setActive("a.ts");

    // Strip order would say b; MRU says c, which is where the user just was.
    expect(selectNextMruTab(useOpenTabsStore.getState())?.relPath).toBe("c.ts");
  });

  it("alternates between two files, which is the common case", () => {
    open("a.ts");
    open("b.ts");

    const next = () => {
      const tab = selectNextMruTab(useOpenTabsStore.getState());
      if (tab) useOpenTabsStore.getState().setActive(tab.relPath);
      return tab?.relPath;
    };

    expect(next()).toBe("a.ts");
    expect(next()).toBe("b.ts");
    expect(next()).toBe("a.ts");
  });

  it("covers tabs the list has never seen", () => {
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.setState({ mru: [] });

    expect(selectMruTabs(useOpenTabsStore.getState())).toHaveLength(2);
  });

  it("forgets a closed tab", () => {
    open("a.ts");
    open("b.ts");
    useOpenTabsStore.getState().closeTab("b.ts");

    expect(useOpenTabsStore.getState().mru).not.toContain("b.ts");
  });

  it("returns nothing when nothing is open", () => {
    expect(selectNextMruTab(useOpenTabsStore.getState())).toBeNull();
  });
});
