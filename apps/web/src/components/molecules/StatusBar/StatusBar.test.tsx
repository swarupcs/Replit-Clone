// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar.tsx";
import {
  useEditorStatusStore,
  type EditorStatus,
} from "../../../store/editorStatusStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { useRunStore } from "../../../store/runStore.ts";

/** A clean file open in a pane, overridden per test. */
function status(overrides: Partial<EditorStatus> = {}): EditorStatus {
  return {
    relPath: "src/App.tsx",
    line: 12,
    column: 4,
    selectionCount: 0,
    language: "typescript",
    tabSize: 2,
    isDirty: false,
    writeError: null,
    canEdit: true,
    shared: false,
    ...overrides,
  };
}

beforeEach(() => {
  useEditorStatusStore.setState({ byPane: {} });
  useOpenTabsStore.setState({ focusedPane: "primary" });
  useRunStore.setState({ state: { status: "idle" } });
});

afterEach(() => {
  cleanup();
});

describe("StatusBar", () => {
  it("reports the cursor and the file", () => {
    useEditorStatusStore.getState().publish("primary", status());
    render(<StatusBar />);

    expect(screen.getByText("Ln 12, Col 4")).toBeDefined();
    expect(screen.getByText("typescript")).toBeDefined();
    expect(screen.getByText("Saved")).toBeDefined();
  });

  /** The bar used to live inside the editor, which returns its empty state
   *  before ever reaching it — so closing the last tab took the bar away. */
  it("stays put when no file is open", () => {
    render(<StatusBar />);

    expect(screen.getByText("No file open")).toBeDefined();
    // And says nothing it cannot know.
    expect(screen.queryByText(/Ln /)).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("follows the focused pane", () => {
    const { publish } = useEditorStatusStore.getState();
    publish("primary", status({ line: 1 }));
    publish("secondary", status({ relPath: "src/api.ts", line: 99 }));

    useOpenTabsStore.setState({ focusedPane: "secondary" });
    render(<StatusBar />);

    expect(screen.getByText("Ln 99, Col 4")).toBeDefined();
  });

  it("falls back to the other pane rather than blanking", () => {
    // Closing the focused pane's last tab clears its entry while the split
    // still has a file open; reporting nothing there would be wrong.
    useEditorStatusStore.getState().publish("secondary", status({ line: 7 }));
    useOpenTabsStore.setState({ focusedPane: "primary" });
    render(<StatusBar />);

    expect(screen.getByText("Ln 7, Col 4")).toBeDefined();
  });

  describe("what it says about saving", () => {
    const cases: [Partial<EditorStatus>, string][] = [
      [{ canEdit: false }, "Read-only"],
      [{ writeError: "too big" }, "Too large"],
      [{ shared: true }, "Shared"],
      [{ isDirty: true }, "Unsaved"],
      [{}, "Saved"],
    ];

    // Order matters: a read-only viewer looking at a dirty shared file should
    // be told the thing that stops them saving, not the other two.
    it.each(cases)("%o reads as %s", (overrides, expected) => {
      useEditorStatusStore.getState().publish("primary", status(overrides));
      render(<StatusBar />);

      expect(screen.getByText(expected)).toBeDefined();
    });
  });

  describe("the run", () => {
    it("says nothing while the project has never been started", () => {
      useEditorStatusStore.getState().publish("primary", status());
      render(<StatusBar />);

      expect(screen.queryByText("Running")).toBeNull();
      expect(screen.queryByText("Stopped")).toBeNull();
    });

    it("shows the dev server once there is something to say", () => {
      useRunStore.setState({ state: { status: "running" } });
      render(<StatusBar />);

      expect(screen.getByText("Running")).toBeDefined();
    });

    it("shows it with no file open, because it is the project's, not the file's", () => {
      useRunStore.setState({ state: { status: "starting" } });
      render(<StatusBar />);

      expect(screen.getByText("No file open")).toBeDefined();
      expect(screen.getByText("Starting")).toBeDefined();
    });
  });
});

describe("the status store", () => {
  it("ignores a publish that changes nothing a reader would see", () => {
    const { publish } = useEditorStatusStore.getState();
    publish("primary", status());
    const before = useEditorStatusStore.getState().byPane;

    // The cursor position is republished on every keystroke; an identical one
    // must not hand the bar a new object to re-render for.
    publish("primary", status());

    expect(useEditorStatusStore.getState().byPane).toBe(before);
  });

  it("forgets a pane that has gone away", () => {
    const store = useEditorStatusStore.getState();
    store.publish("secondary", status());
    store.clear("secondary");

    expect(useEditorStatusStore.getState().byPane.secondary).toBeUndefined();
  });
});
