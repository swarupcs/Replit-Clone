// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SearchMatch } from "@replit-clone/shared";
import { SearchPanel } from "./SearchPanel.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

/** A socket that hands back the handlers the panel registers, so results can
 *  be delivered directly — the search itself is debounced, and none of these
 *  tests are about the debounce. */
function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emit = vi.fn();

  return {
    emit,
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    },
    off: () => undefined,
    /** Delivers a `searchResults` payload the way the server would. The query
     *  is echoed back because the panel drops a reply that does not match the
     *  one it is waiting on — a slow answer for an old query must not
     *  overwrite a newer one. */
    deliver(query: string, matches: SearchMatch[]) {
      act(() => {
        handlers.get("searchResults")?.({ query, matches, truncated: false });
      });
    },
  };
}

const MATCHES: SearchMatch[] = [
  { relPath: "src/App.tsx", line: 12, column: 3, preview: "  const a = 1;" },
  { relPath: "src/App.tsx", line: 40, column: 1, preview: "export default App;" },
];

let socket: ReturnType<typeof fakeSocket>;

/** Types a query and lets the debounce elapse, so the panel is waiting on a
 *  reply for it. */
function search(query: string) {
  fireEvent.change(screen.getByPlaceholderText(/search/i), {
    target: { value: query },
  });
  act(() => {
    vi.advanceTimersByTime(400);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  socket = fakeSocket();
  useEditorSocketStore.setState({
    editorSocket: socket as unknown as ReturnType<
      typeof useEditorSocketStore.getState
    >["editorSocket"],
    accessLevel: "editor",
  });
  useOpenTabsStore.setState({ tabs: [], activeRelPath: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("search results", () => {
  it("shows a match per hit, grouped under its file", () => {
    render(<SearchPanel />);
    search("a");
    socket.deliver("a", MATCHES);

    expect(screen.getByText("App.tsx")).toBeDefined();
    expect(screen.getByText("const a = 1;")).toBeDefined();
    expect(screen.getByText("export default App;")).toBeDefined();
  });

  /** The rows were `div`s with a click handler, so a keyboard user could see
   *  every result and reach none of them. */
  it("makes each match a real button, in the tab order", () => {
    render(<SearchPanel />);
    search("a");
    socket.deliver("a", MATCHES);

    const rows = screen.getAllByRole("button", { name: /const a = 1;/ });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tagName).toBe("BUTTON");
  });

  it("opens the file from the keyboard, the same as from a click", () => {
    render(<SearchPanel />);
    search("a");
    socket.deliver("a", MATCHES);

    const row = screen.getByRole("button", { name: /const a = 1;/ });
    // A button's Enter arrives as a click, which is exactly the point of
    // making it one rather than handling keys by hand.
    fireEvent.click(row);

    expect(socket.emit).toHaveBeenCalledWith("readFile", {
      relPath: "src/App.tsx",
    });
    // And the position is queued for the editor to reveal once the file lands.
    expect(useOpenTabsStore.getState().pendingReveal).toEqual({
      relPath: "src/App.tsx",
      line: 12,
      column: 3,
    });
  });
});
