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


/** The shell tabs used to be `button`s holding a `span role="button"` close —
 *  a button inside a button, which is invalid markup that browsers resolve by
 *  dropping one of them, and which left the close unreachable by keyboard.
 *
 *  They are `div role="tab"` now, so everything a button gave for free has to
 *  be provided: selection on Enter and Space, and a way to close. */
describe("panel tabs from the keyboard", () => {
  /** The tab strip's tabs, in the order they appear. */
  function tabs() {
    return screen.getAllByRole("tab");
  }

  it("presents the shells and Output as one set of tabs", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    expect(screen.getByRole("tablist", { name: "Panel" })).toBeDefined();
    expect(tabs().map((tab) => tab.dataset["rcTab"])).toEqual([
      "terminal:1",
      "terminal:2",
      "output",
    ]);
  });

  it("is a single tab stop, on whichever tab is selected", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    const tabbable = tabs().filter(
      (tab) => tab.getAttribute("tabindex") === "0",
    );

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.dataset["rcTab"]).toBe("terminal:2");
  });

  it("selects with Enter and with Space, as the buttons used to", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    for (const key of ["Enter", " "]) {
      fireEvent.click(screen.getByText("Shell 2"));
      fireEvent.keyDown(screen.getByText("Shell 1"), { key });
      expect(screen.getByText("Shell 1").getAttribute("aria-selected")).toBe(
        "true",
      );
    }
  });

  it("moves along the strip with the arrows, selecting as it goes", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));
    fireEvent.click(screen.getByText("Shell 1"));

    fireEvent.keyDown(screen.getByText("Shell 1"), { key: "ArrowRight" });

    expect(screen.getByText("Shell 2").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByText("Shell 2"));
  });

  it("stops at the ends rather than wrapping round", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByText("Shell 1"));

    fireEvent.keyDown(screen.getByText("Shell 1"), { key: "ArrowLeft" });

    expect(screen.getByText("Shell 1").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("closes a shell with Delete", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    fireEvent.keyDown(screen.getByText("Shell 2"), { key: "Delete" });

    expect(screen.queryByText("Shell 2")).toBeNull();
  });

  it("refuses Delete on the last shell and on Output", () => {
    render(<BottomPanel projectId={PROJECT} />);

    // Closing a lone shell would only immediately spawn a replacement, and
    // Output is not closable at all.
    fireEvent.keyDown(screen.getByText("Shell 1"), { key: "Delete" });
    fireEvent.keyDown(screen.getByText("Output"), { key: "Delete" });

    expect(screen.getByText("Shell 1")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
  });

  it("gives the close affordance a real button, out of the tab order", () => {
    render(<BottomPanel projectId={PROJECT} />);
    fireEvent.click(screen.getByLabelText("New shell"));

    const close = screen.getByLabelText("Close shell 2");

    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("tabindex")).toBe("-1");
  });
});
