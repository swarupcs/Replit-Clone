// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** Counts renders per file row — only a file renders a FileIcon, which makes
 *  it a per-row counter without touching the components under test. */
const rowRenders = new Map<string, number>();

vi.mock("../../atoms/FileIcon/FileIcon.tsx", () => ({
  FileIcon: ({ name }: { name: string }) => {
    rowRenders.set(name, (rowRenders.get(name) ?? 0) + 1);
    return <span />;
  },
}));
import type { TreeNodeData } from "@replit-clone/shared";
import { TreeStructure } from "./TreeStructure.tsx";
import { useTreeStructureStore } from "../../../store/treeStructureStore.ts";
import { useTreeSelectionStore } from "../../../store/treeSelectionStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { usePresenceStore } from "../../../store/presenceStore.ts";

/** A project with `folders` top-level directories, each holding one file.
 *
 *  The count matters: React aborts at 50 nested updates, so a bug that costs
 *  one update per folder only shows above that threshold. Real projects are
 *  well past it; the handful of folders a fixture usually has is not. */
function projectWith(folders: number): TreeNodeData {
  return {
    name: "root",
    relPath: "",
    type: "directory",
    children: Array.from({ length: folders }, (_, i) => ({
      name: `dir${String(i)}`,
      relPath: `dir${String(i)}`,
      type: "directory" as const,
      children: [
        {
          name: "index.ts",
          relPath: `dir${String(i)}/index.ts`,
          type: "file" as const,
        },
      ],
    })),
  };
}

beforeEach(() => {
  rowRenders.clear();
  useTreeStructureStore.setState({
    projectId: "p1",
    treeStructure: projectWith(80),
    expandedPaths: new Set<string>(),
  });
  useTreeSelectionStore.setState({
    selected: new Set<string>(),
    anchor: null,
    visibleOrder: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TreeStructure", () => {
  it("renders the tree", () => {
    render(<TreeStructure />);
    expect(screen.getByText("dir0")).toBeDefined();
  });

  it("mounts a large project without exceeding React's update depth", () => {
    // The crash surfaced as "Maximum update depth exceeded", which React
    // reports through console.error rather than by throwing where a test can
    // catch it.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    render(<TreeStructure />);

    expect(errors.join("\n")).not.toMatch(/Maximum update depth/i);
  });

  it("reveals matching folders in one update when filtering", () => {
    render(<TreeStructure />);

    let writes = 0;
    const stop = useTreeStructureStore.subscribe(() => {
      writes += 1;
    });

    // Reveal every folder at once, the way the filter effect does. Looping
    // over revealPath here was one write -- and one render -- per folder,
    // which is what tripped React's limit on a real project.
    const all = useTreeStructureStore.getState().treeStructure;
    const folders = (all?.children ?? []).map((child) => child.relPath);
    useTreeStructureStore.getState().revealPaths(
      folders.map((folder) => `${folder}/index.ts`),
    );
    stop();

    expect(writes).toBe(1);
  });

  it("settles rather than re-rendering forever", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    render(<TreeStructure />);

    // Expanding everything is what the filter does; if publishing the visible
    // order feeds back into expansion, this never comes to rest.
    const folders = (
      useTreeStructureStore.getState().treeStructure?.children ?? []
    ).map((child) => `${child.relPath}/index.ts`);

    useTreeStructureStore.getState().revealPaths(folders);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.join("\n")).not.toMatch(/Maximum update depth/i);
    expect(useTreeSelectionStore.getState().visibleOrder.length).toBeGreaterThan(
      0,
    );
  });
});

/** The panel re-renders for reasons of its own — a keystroke in the filter, a
 *  refresh spinner, the new-file input opening. None of those change the tree,
 *  and re-rendering every row for them is the cost this guards against. */
describe("what the panel's own state costs the tree", () => {
  /** Files at the root, so every row shows without expanding anything. */
  function flatProject(): TreeNodeData {
    return {
      name: "root",
      relPath: "",
      type: "directory",
      children: [
        { name: "a.ts", relPath: "a.ts", type: "file" },
        { name: "b.ts", relPath: "b.ts", type: "file" },
      ],
    };
  }

  beforeEach(() => {
    useTreeStructureStore.setState({
      projectId: "p1",
      treeStructure: flatProject(),
      expandedPaths: new Set<string>(),
    });
    rowRenders.clear();
  });

  it("renders no row again when the new-file input opens", () => {
    render(<TreeStructure />);
    const before = [rowRenders.get("a.ts"), rowRenders.get("b.ts")];

    fireEvent.click(screen.getByLabelText("New file"));

    expect([rowRenders.get("a.ts"), rowRenders.get("b.ts")]).toEqual(before);
  });

  /** A filter that trims to nothing leaves the tree exactly as it was, so the
   *  keystroke belongs to the input and to nothing else. */
  it("renders no row again for a keystroke that changes no result", () => {
    render(<TreeStructure />);
    const before = [rowRenders.get("a.ts"), rowRenders.get("b.ts")];

    fireEvent.change(screen.getByPlaceholderText(/filter/i), {
      target: { value: "  " },
    });

    expect([rowRenders.get("a.ts"), rowRenders.get("b.ts")]).toEqual(before);
  });
});


/** The tree was reachable only with a mouse: rows were plain `div`s with a
 *  click handler, so a keyboard user could not open a file from it at all.
 *
 *  The rules themselves live in `lib/treeKeys.ts` and are tested there. What
 *  these cover is the wiring — that a key press moves real DOM focus, and that
 *  opening from the keyboard does the same thing opening with the mouse does.
 */
describe("keyboard navigation", () => {
  /** One folder holding a file, and a file beside it. */
  function mixedProject(): TreeNodeData {
    return {
      name: "root",
      relPath: "",
      type: "directory",
      children: [
        {
          name: "src",
          relPath: "src",
          type: "directory",
          children: [{ name: "a.ts", relPath: "src/a.ts", type: "file" }],
        },
        { name: "readme.md", relPath: "readme.md", type: "file" },
      ],
    };
  }

  const emit = vi.fn();

  beforeEach(() => {
    emit.mockClear();
    useTreeStructureStore.setState({
      projectId: "p1",
      treeStructure: mixedProject(),
      expandedPaths: new Set<string>(),
    });
    useEditorSocketStore.setState({
      editorSocket: { emit } as unknown as ReturnType<
        typeof useEditorSocketStore.getState
      >["editorSocket"],
    });
  });

  /** The row for a path, found the way the component's own handler does. */
  function row(relPath: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(
      `[data-rc-path="${relPath}"]`,
    );
    if (!found) throw new Error(`no row for ${relPath}`);
    return found;
  }

  it("exposes the rows as a tree rather than as anonymous divs", () => {
    render(<TreeStructure />);

    expect(screen.getByRole("tree", { name: "Files" })).toBeDefined();
    // The collapsed folder announces that it can be opened; a file has no
    // expanded state at all, which is the difference `aria-expanded` carries.
    expect(row("src").getAttribute("aria-expanded")).toBe("false");
    expect(row("readme.md").hasAttribute("aria-expanded")).toBe(false);
  });

  it("is a single tab stop, not one per file", () => {
    render(<TreeStructure />);

    const tabbable = screen
      .getAllByRole("treeitem")
      .filter((node) => node.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.dataset["rcPath"]).toBe("src");
  });

  it("moves focus down the rows on screen", () => {
    render(<TreeStructure />);

    row("src").focus();
    fireEvent.keyDown(row("src"), { key: "ArrowDown" });

    expect(document.activeElement).toBe(row("readme.md"));
  });

  it("opens a folder with Right and steps into it with the next Right", () => {
    render(<TreeStructure />);

    row("src").focus();
    fireEvent.keyDown(row("src"), { key: "ArrowRight" });

    expect(useTreeStructureStore.getState().expandedPaths.has("src")).toBe(true);

    fireEvent.keyDown(row("src"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(row("src/a.ts"));
  });

  it("opens a file with Enter, the same way a click does", () => {
    render(<TreeStructure />);

    row("readme.md").focus();
    fireEvent.keyDown(row("readme.md"), { key: "Enter" });

    expect(emit).toHaveBeenCalledWith("readFile", { relPath: "readme.md" });
    // And selects it, so a follow-up action from the context menu acts on the
    // row the user is actually on.
    expect(useTreeSelectionStore.getState().selected.has("readme.md")).toBe(
      true,
    );
  });

  it("keeps the tab stop on the row the user left", () => {
    render(<TreeStructure />);

    row("readme.md").focus();

    expect(useTreeSelectionStore.getState().focused).toBe("readme.md");
    expect(row("readme.md").getAttribute("tabindex")).toBe("0");
    expect(row("src").getAttribute("tabindex")).toBe("-1");
  });

  it("gives the tab stop back when the focused row leaves the screen", () => {
    render(<TreeStructure />);

    row("src").focus();
    fireEvent.keyDown(row("src"), { key: "ArrowRight" });
    row("src/a.ts").focus();
    expect(useTreeSelectionStore.getState().focused).toBe("src/a.ts");

    // Collapsing takes the focused row off screen. Left dangling, it would be
    // the tab stop for a row that no longer exists and the tree would have
    // none at all.
    fireEvent.keyDown(row("src"), { key: "ArrowLeft" });

    expect(useTreeSelectionStore.getState().focused).toBeNull();
    expect(
      screen
        .getAllByRole("treeitem")
        .filter((node) => node.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });
});


/** Presence marks the files someone else is in. The tree renders one row per
 *  file in the project, so how it subscribes matters as much as what it
 *  shows. */
describe("presence in the tree", () => {
  function flatProject(): TreeNodeData {
    return {
      name: "root",
      relPath: "",
      type: "directory",
      children: [
        { name: "a.ts", relPath: "a.ts", type: "file" },
        { name: "b.ts", relPath: "b.ts", type: "file" },
      ],
    };
  }

  beforeEach(() => {
    useTreeStructureStore.setState({
      projectId: "p1",
      treeStructure: flatProject(),
      expandedPaths: new Set<string>(),
    });
    usePresenceStore.setState({ peers: [], colorsByFile: {} });
    rowRenders.clear();
  });

  it("marks a file somebody else is in", () => {
    render(<TreeStructure />);
    act(() => {
      usePresenceStore.setState({ colorsByFile: { "a.ts": "red" } });
    });

    expect(screen.getByLabelText("Someone else is in this file")).toBeDefined();
  });

  it("leaves every other row alone when someone moves", () => {
    render(<TreeStructure />);
    const before = rowRenders.get("b.ts");

    act(() => {
      usePresenceStore.setState({ colorsByFile: { "a.ts": "red" } });
    });

    // The row subscribes to a STRING of its own file's colours, not to the
    // presence map: an array or an object would hand every row a new identity
    // on every awareness update and wake the whole tree for one person moving.
    expect(rowRenders.get("b.ts")).toBe(before);
  });
});
