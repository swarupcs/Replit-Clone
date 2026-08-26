// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { BottomPanel } from "./BottomPanel.tsx";
import { useRunStore } from "../../../store/runStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

/** A terminal owns a WebSocket and a PTY, neither of which exists here. The
 *  panel's job is which panes exist and which is visible, so the shell itself
 *  is stood in for by a marker carrying the instance it belongs to. */
let mounted = 0;
vi.mock("../../molecules/BrowserTerminal/BrowserTerminal.tsx", () => ({
  BrowserTerminal: ({ projectId }: { projectId: string }) => {
    // Counts MOUNTS, not renders: a re-render is harmless, but a remount would
    // kill the PTY and lose the scrollback in the real app.
    useEffect(() => {
      mounted += 1;
    }, []);
    return <div data-testid="shell" data-project={projectId} />;
  },
}));

/** React's onAuxClick listens for the DOM `auxclick` event, which fireEvent
 *  has no shorthand for. */
function auxClick(node: Element, button: number) {
  fireEvent(node, new MouseEvent("auxclick", { button, bubbles: true }));
}

vi.mock("../../molecules/RunOutput/RunOutput.tsx", () => ({
  RunOutput: () => <div data-testid="run-output" />,
}));

const PROJECT = "p1";

/** The pane wrapper hides rather than unmounts, so "visible" is a style. */
function visiblePanes() {
  return screen
    .getAllByTestId("shell")
    .map((node) => node.parentElement)
    .filter((pane) => pane?.style.display !== "none");
}

beforeEach(() => {
  mounted = 0;
  useEditorSocketStore.setState({ accessLevel: "editor" });
  useRunStore.setState({ state: { status: "idle" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BottomPanel terminals", () => {
  it("opens with one shell, selected, and no close button", () => {
    render(<BottomPanel projectId={PROJECT} />);

    expect(screen.getByText("Shell 1")).toBeDefined();
    expect(screen.queryByLabelText("Close shell 1")).toBeNull();
    expect(visiblePanes()).toHaveLength(1);
  });

  it("adds a shell and switches to it", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    expect(screen.getByText("Shell 2")).toBeDefined();
    expect(screen.getAllByTestId("shell")).toHaveLength(2);
    // The new one is the visible one.
    expect(visiblePanes()).toHaveLength(1);
  });

  it("keeps every shell mounted while switching tabs", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));
    expect(mounted).toBe(2);

    fireEvent.click(screen.getByText("Shell 1"));
    fireEvent.click(screen.getByText("Shell 2"));

    // Switching must not construct another shell: doing so would kill the PTY
    // and lose the scrollback.
    expect(mounted).toBe(2);
    expect(screen.getAllByTestId("shell")).toHaveLength(2);
  });

  it("closes a shell and drops its pane", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    fireEvent.click(screen.getByLabelText("Close shell 2"));

    expect(screen.getAllByTestId("shell")).toHaveLength(1);
    expect(screen.queryByText("Shell 2")).toBeNull();
  });

  it("renumbers by position, so ids never show through as gaps", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));
    fireEvent.click(screen.getByLabelText("New shell"));
    expect(screen.getByText("Shell 3")).toBeDefined();

    // Close the middle one: the third becomes "Shell 2", not "Shell 3".
    fireEvent.click(screen.getByLabelText("Close shell 2"));

    expect(screen.getByText("Shell 1")).toBeDefined();
    expect(screen.getByText("Shell 2")).toBeDefined();
    expect(screen.queryByText("Shell 3")).toBeNull();
  });

  it("moves the selection off a closed shell", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    // Shell 2 is active; closing it must leave something visible.
    fireEvent.click(screen.getByLabelText("Close shell 2"));

    expect(visiblePanes()).toHaveLength(1);
  });

  it("replaces the last shell rather than leaving the panel empty", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    fireEvent.click(screen.getByLabelText("Close shell 1"));
    // One left, so it loses its close button.
    expect(screen.queryByLabelText("Close shell 1")).toBeNull();

    // There is no close button now, so closing the last one goes through the
    // middle-click path the tab still honours.
    auxClick(screen.getByText("Shell 1"), 1);

    // A replacement appears rather than an empty panel.
    expect(screen.getAllByTestId("shell")).toHaveLength(1);
    expect(screen.getByText("Shell 1")).toBeDefined();
  });

  it("closes a shell on middle click", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    auxClick(screen.getByText("Shell 2"), 1);

    expect(screen.getAllByTestId("shell")).toHaveLength(1);
  });

  it("ignores a right click on a tab", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    auxClick(screen.getByText("Shell 2"), 2);

    expect(screen.getAllByTestId("shell")).toHaveLength(2);
  });
});

describe("BottomPanel output", () => {
  it("pulls attention to the output when a run starts", () => {
    render(<BottomPanel projectId={PROJECT} />);
    expect(visiblePanes()).toHaveLength(1);

    act(() => {
      useRunStore.setState({ state: { status: "starting" } });
    });

    // The shell panes are all hidden; the output is what is showing.
    expect(visiblePanes()).toHaveLength(0);
    expect(screen.getByTestId("run-output").parentElement?.style.display).toBe(
      "block",
    );
  });

  it("marks the output tab while the dev server runs", () => {
    render(<BottomPanel projectId={PROJECT} />);
    expect(screen.queryByLabelText("Dev server running")).toBeNull();

    act(() => {
      useRunStore.setState({ state: { status: "running" } });
    });

    expect(screen.getByLabelText("Dev server running")).toBeDefined();
  });
});

describe("BottomPanel access", () => {
  it("gives a viewer no shell at all", () => {
    useEditorSocketStore.setState({ accessLevel: "viewer" });
    render(<BottomPanel projectId={PROJECT} />);

    expect(screen.queryAllByTestId("shell")).toHaveLength(0);
    expect(screen.getByText(/read-only access/)).toBeDefined();
    // The output is still theirs to read.
    expect(screen.getByTestId("run-output")).toBeDefined();
  });
});
