// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
