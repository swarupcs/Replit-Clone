// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { TreeNodeData } from "@replit-clone/shared";

/** Counts renders per file row.
 *
 *  Only a file renders a FileIcon, which makes it a precise per-row counter
 *  without touching the component under test. */
const renders = new Map<string, number>();

vi.mock("../../atoms/FileIcon/FileIcon.tsx", () => ({
  FileIcon: ({ name }: { name: string }) => {
    renders.set(name, (renders.get(name) ?? 0) + 1);
    return <span data-testid={`icon-${name}`} />;
  },
}));

import { TreeNode } from "./TreeNode.tsx";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useFileContextMenuStore } from "../../../store/fileContextMenuStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useTreeSelectionStore } from "../../../store/treeSelectionStore.ts";

/** Two files at the root, and a folder that can be opened and closed without
 *  either of them being involved. */
const TREE: TreeNodeData = {
  name: "root",
  relPath: "",
  type: "directory",
  children: [
    { name: "a.ts", relPath: "a.ts", type: "file" },
    { name: "b.ts", relPath: "b.ts", type: "file" },
    {
      name: "elsewhere",
      relPath: "elsewhere",
      type: "directory",
      children: [{ name: "c.ts", relPath: "elsewhere/c.ts", type: "file" }],
    },
  ],
};

function rendersOf(name: string): number {
  return renders.get(name) ?? 0;
}

beforeEach(() => {
  renders.clear();
  useTreeStructureStore.setState({
    projectId: "p1",
    treeStructure: TREE,
    expandedPaths: new Set<string>(),
  });
  useEditorSocketStore.setState({
    editorSocket: null,
    lastError: null,
    accessLevel: "editor",
    externallyChanged: [],
  });
  useFileContextMenuStore.setState({ x: 0, y: 0, isOpen: false, node: null });
  useOpenTabsStore.setState({
    tabs: [],
    activeRelPath: null,
    secondaryRelPath: null,
    splitOpen: false,
    focusedPane: "primary",
    pendingReveal: null,
    review: null,
  });
  useTreeSelectionStore.setState({
    selected: new Set<string>(),
    anchor: null,
    visibleOrder: [],
  });
});

afterEach(() => {
  cleanup();
});

/** Every row subscribed to a whole store, so any change in any of them woke
 *  the entire tree. In a real project that is one re-render per file for
 *  something as ordinary as a right-click. */
describe("what wakes a tree row", () => {
  it("renders each row once to begin with", () => {
    render(<TreeNode node={TREE} />);

    expect(rendersOf("a.ts")).toBe(1);
    expect(rendersOf("b.ts")).toBe(1);
  });

  it("leaves other rows alone when a folder is expanded", () => {
    render(<TreeNode node={TREE} />);
    const before = rendersOf("a.ts");

    act(() => {
      useTreeStructureStore.getState().toggleExpanded("elsewhere");
    });

    expect(rendersOf("a.ts")).toBe(before);
    // ...and the folder's own children did arrive.
    expect(rendersOf("c.ts")).toBe(1);
  });

  /** The context menu store carries the pointer position and the node it was
   *  opened on, all of which change on every right-click. */
  it("leaves every row alone when the context menu opens", () => {
    render(<TreeNode node={TREE} />);
    const before = [rendersOf("a.ts"), rendersOf("b.ts")];

    act(() => {
      useFileContextMenuStore
        .getState()
        .open(10, 20, { name: "a.ts", relPath: "a.ts", type: "file" });
    });

    expect([rendersOf("a.ts"), rendersOf("b.ts")]).toEqual(before);
  });

  /** Reported whenever a terminal command or a build step writes a file. */
  it("leaves every row alone when a file changes outside the editor", () => {
    render(<TreeNode node={TREE} />);
    const before = [rendersOf("a.ts"), rendersOf("b.ts")];

    act(() => {
      useEditorSocketStore.setState({ externallyChanged: ["a.ts"] });
    });

    expect([rendersOf("a.ts"), rendersOf("b.ts")]).toEqual(before);
  });

  /** Opening a file has to repaint the row that gained the highlight and the
   *  one that lost it — and nothing else. */
  it("wakes only the rows whose highlight moved", () => {
    render(<TreeNode node={TREE} />);

    act(() => {
      useOpenTabsStore.setState({ activeRelPath: "a.ts" });
    });
    const afterFirst = rendersOf("b.ts");

    act(() => {
      useOpenTabsStore.setState({ activeRelPath: "b.ts" });
    });

    // a.ts painted twice more than its first render: once gaining the
    // highlight, once losing it. b.ts sat out the first move entirely.
    expect(rendersOf("a.ts")).toBe(3);
    expect(afterFirst).toBe(1);
    expect(rendersOf("b.ts")).toBe(2);
  });

  it("still shows a row as expanded once it is", () => {
    const view = render(<TreeNode node={TREE} />);

    expect(view.queryByTestId("icon-c.ts")).toBeNull();

    act(() => {
      useTreeStructureStore.getState().toggleExpanded("elsewhere");
    });

    expect(view.queryByTestId("icon-c.ts")).not.toBeNull();
  });
});
