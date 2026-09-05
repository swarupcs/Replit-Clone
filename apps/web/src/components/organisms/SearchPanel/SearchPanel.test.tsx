// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SearchMatch } from "@replit-clone/shared";
import { SearchPanel } from "./SearchPanel.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

const searchAllProjectsApi = vi.hoisted(() => vi.fn());
vi.mock("../../../apis/projects.ts", () => ({ searchAllProjectsApi }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  )),
  useNavigate: () => navigate,
}));

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
  useOpenTabsStore.setState({ tabs: [], activeRelPath: null, pendingReveal: null });
  searchAllProjectsApi.mockResolvedValue({
    projects: [],
    scanned: 0,
    total: 0,
    truncated: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("search results", () => {
  it("shows a match per hit, grouped under its file", () => {
    render(<SearchPanel />, { wrapper: MemoryRouter });
    search("a");
    socket.deliver("a", MATCHES);

    expect(screen.getByText("App.tsx")).toBeDefined();
    expect(screen.getByText("const a = 1;")).toBeDefined();
    expect(screen.getByText("export default App;")).toBeDefined();
  });

  /** The rows were `div`s with a click handler, so a keyboard user could see
   *  every result and reach none of them. */
  it("makes each match a real button, in the tab order", () => {
    render(<SearchPanel />, { wrapper: MemoryRouter });
    search("a");
    socket.deliver("a", MATCHES);

    const rows = screen.getAllByRole("button", { name: /const a = 1;/ });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tagName).toBe("BUTTON");
  });

  it("opens the file from the keyboard, the same as from a click", () => {
    render(<SearchPanel />, { wrapper: MemoryRouter });
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

/** Searching across projects rather than inside one.
 *
 *  This is the only search whose result the user cannot place from the path
 *  alone, and the only one that has to leave the project they are in — so the
 *  two things worth testing are that it says which project, and that clicking
 *  a result actually lands on the line rather than on the project's doorstep.
 */
describe("searching every project", () => {
  const ELSEWHERE = {
    projects: [
      {
        projectId: "p9",
        name: "Old API",
        matches: [
          { relPath: "src/db.ts", line: 7, column: 2, preview: "const pool = x" },
        ],
        truncated: false,
      },
    ],
    scanned: 3,
    total: 3,
    truncated: false,
  };

  function widen() {
    fireEvent.click(
      screen.getByRole("button", { name: /search every project/i }),
    );
  }

  /** Lets the API promise settle. `waitFor` and `findBy*` poll on timers, and
   *  the timers here are fake — so they wait for a tick that this test is the
   *  one responsible for advancing, and hang. Flushing microtasks directly is
   *  what those helpers would be doing if they could. */
  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("is off until asked for, so the ordinary search stays the fast one", () => {
    render(<SearchPanel />, { wrapper: MemoryRouter });
    search("pool");

    expect(searchAllProjectsApi).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "search",
      expect.objectContaining({ query: "pool" }),
    );
  });

  /** The socket is bound to one project, so the wider search cannot go over
   *  it. Sending it there anyway would silently search only this project. */
  it("goes over HTTP rather than the project's socket", async () => {
    searchAllProjectsApi.mockResolvedValue(ELSEWHERE);
    render(<SearchPanel />, { wrapper: MemoryRouter });
    widen();
    search("pool");

    await settle();

    expect(searchAllProjectsApi).toHaveBeenCalledWith(
      expect.objectContaining({ query: "pool" }),
    );
    expect(socket.emit).not.toHaveBeenCalledWith("search", expect.anything());
  });

  /** "src/db.ts" is in most of somebody's projects, so the project name is
   *  the part of the answer that does the work. */
  it("says which project each result came from", async () => {
    searchAllProjectsApi.mockResolvedValue(ELSEWHERE);
    render(<SearchPanel />, { wrapper: MemoryRouter });
    widen();
    search("pool");

    await settle();

    expect(screen.getByText("Old API")).toBeDefined();
    expect(screen.getByText("const pool = x")).toBeDefined();
  });

  /** Finding the right project and dropping the user at its front door is
   *  most of the way to useless: the file is the answer, not the project. The
   *  reveal is requested before navigating because the tab store outlives the
   *  route and the socket does not. */
  it("asks for the line before navigating to the project that has it", async () => {
    searchAllProjectsApi.mockResolvedValue(ELSEWHERE);
    render(<SearchPanel />, { wrapper: MemoryRouter });
    widen();
    search("pool");

    await settle();
    fireEvent.click(screen.getByRole("button", { name: /const pool = x/ }));

    expect(useOpenTabsStore.getState().pendingReveal).toEqual({
      relPath: "src/db.ts",
      line: 7,
      column: 2,
    });
    expect(navigate).toHaveBeenCalledWith("/project/p9");
  });

  /** A search that stopped early and did not say so makes a missing result
   *  look like proof the text is nowhere. */
  it("says so when it could not look everywhere", async () => {
    searchAllProjectsApi.mockResolvedValue({
      ...ELSEWHERE,
      scanned: 25,
      total: 40,
      truncated: true,
    });
    render(<SearchPanel />, { wrapper: MemoryRouter });
    widen();
    search("pool");

    await settle();

    expect(screen.getByText(/searched 25 of 40/)).toBeDefined();
  });

  it("says plainly when nothing matched anywhere", async () => {
    render(<SearchPanel />, { wrapper: MemoryRouter });
    widen();
    search("nowhere");

    await settle();

    expect(screen.getByText(/in any of your projects/)).toBeDefined();
  });
});
