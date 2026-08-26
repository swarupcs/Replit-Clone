// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectPlayground } from "./ProjectPlayground.tsx";
import { useAuthStore } from "../store/authStore.ts";
import { useEditorSocketStore } from "../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../store/openTabsStore.ts";
import { useRunStore } from "../store/runStore.ts";
import { useWorkspaceStore } from "../store/workspaceStore.ts";

const PROJECT = "p1";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ projectId: PROJECT }),
  };
});

/** The socket.io client, standing in for a real connection. Every handler the
 *  page registers is captured so a server event can be delivered by hand. */
const handlers = new Map<string, (payload: unknown) => void>();
const emitted: { event: string; payload?: unknown }[] = [];
const socket = {
  on: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
  },
  off: vi.fn(),
  emit: (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
  },
  disconnect: vi.fn(),
  close: vi.fn(),
};
vi.mock("socket.io-client", () => ({ io: () => socket }));

// Monaco, xterm and the preview iframe each own resources jsdom has no
// equivalent for. The page's own job -- layout, hotkeys, commands, banners --
// is what is under test, so the children are stood in for by markers.
vi.mock("../components/molecules/EditorComponent/EditorComponent.tsx", () => ({
  EditorComponent: () => <div data-testid="editor" />,
}));
vi.mock("../components/organisms/BottomPanel/BottomPanel.tsx", () => ({
  BottomPanel: () => <div data-testid="bottom-panel" />,
}));
vi.mock("../components/organisms/Browser/Browser.tsx", () => ({
  Browser: () => <div data-testid="preview" />,
}));
vi.mock("../components/organisms/TreeStructure/TreeStructure.tsx", () => ({
  TreeStructure: () => <div data-testid="tree" />,
}));
vi.mock("../components/organisms/SearchPanel/SearchPanel.tsx", () => ({
  SearchPanel: () => <div data-testid="search-panel" />,
}));
vi.mock("../components/organisms/SourceControlPanel/SourceControlPanel.tsx", () => ({
  SourceControlPanel: () => <div data-testid="git-panel" />,
}));
vi.mock("../components/organisms/AiPanel/AiPanel.tsx", () => ({
  AiPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("../lib/collab.ts", () => ({ installCollab: () => () => undefined }));

const installProjectSources = vi.hoisted(() => vi.fn());
const clearProjectSources = vi.hoisted(() => vi.fn());
vi.mock("../lib/projectSources.ts", () => ({
  installProjectSources,
  clearProjectSources,
}));
// The real loader pulls in Monaco, which jsdom cannot run.
vi.mock("@monaco-editor/react", () => ({
  loader: { init: () => Promise.resolve({ fake: "monaco" }) },
}));

const getAiStatusApi = vi.hoisted(() => vi.fn());
vi.mock("../apis/ai.ts", () => ({ getAiStatusApi }));

/** The server announces the caller's level once the socket is up; until it
 *  does the store holds null, so nothing is editable. */
function grantAccess(level: "viewer" | "editor" | "owner") {
  act(() => {
    handlers.get("projectAccess")?.({ level });
  });
}

function renderPlayground() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectPlayground />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  // No assistant configured, so the AI rail button stays away by default.
  getAiStatusApi.mockResolvedValue({ configured: false });

  useAuthStore.setState({ accessToken: "token", user: null, isReady: true });
  useEditorSocketStore.setState({
    editorSocket: null,
    // Null until the server announces it, which is what connecting does.
    accessLevel: null,
    lastError: null,
    externallyChanged: [],
  });
  useOpenTabsStore.getState().closeAll();
  useRunStore.setState({ state: { status: "idle" }, readyNonce: 0 });
  useWorkspaceStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectPlayground layout", () => {
  it("shows the editor, the tree and the panel by default", () => {
    renderPlayground();

    expect(screen.getByTestId("editor")).toBeDefined();
    expect(screen.getByTestId("tree")).toBeDefined();
    expect(screen.getByTestId("bottom-panel")).toBeDefined();
  });

  /** The bar was rendered by `EditorComponent`, so a split produced two of
   *  them and closing every tab left none. It belongs to the page now — which
   *  is what these assert: the editor is mocked here, so a bar that had moved
   *  back inside it would not be found at all. */
  it("owns one status bar, whatever the editor is doing", () => {
    renderPlayground();

    expect(document.querySelectorAll(".rc-statusbar")).toHaveLength(1);

    // Not nested inside a pane — one bar for the app, not one per editor.
    const bar = document.querySelector(".rc-statusbar");
    expect(bar?.closest("[data-testid='editor']")).toBeNull();
  });

  it("keeps the status bar when the editor splits in two", () => {
    renderPlayground();
    act(() => {
      useOpenTabsStore.setState({ splitOpen: true });
    });

    expect(document.querySelectorAll(".rc-statusbar")).toHaveLength(1);
  });

  it("hides the preview until it is asked for", () => {
    renderPlayground();
    expect(screen.queryByTestId("preview")).toBeNull();

    fireEvent.click(screen.getByLabelText("Toggle preview"));
    expect(screen.getByTestId("preview")).toBeDefined();
  });

  it("toggles the file tree", () => {
    renderPlayground();
    expect(screen.getByTestId("tree")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Toggle file tree"));
    expect(screen.queryByTestId("tree")).toBeNull();
  });

  it("toggles the bottom panel", () => {
    renderPlayground();
    fireEvent.click(screen.getByLabelText("Toggle panel"));
    expect(screen.queryByTestId("bottom-panel")).toBeNull();
  });

  it("remembers the arrangement, so a reload restores it", () => {
    renderPlayground();
    fireEvent.click(screen.getByLabelText("Toggle preview"));

    expect(useWorkspaceStore.getState().get(PROJECT)?.showPreview).toBe(true);
  });
});

describe("ProjectPlayground sidebar views", () => {
  it("switches to search", () => {
    renderPlayground();
    fireEvent.click(screen.getByLabelText("Search"));

    expect(screen.getByTestId("search-panel")).toBeDefined();
  });

  it("switches to source control, and back to the files", () => {
    renderPlayground();
    fireEvent.click(screen.getByLabelText("Source control"));
    expect(screen.getByTestId("git-panel")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Explorer"));
    expect(screen.getByTestId("tree")).toBeDefined();
  });

  it("offers no assistant when none is configured", () => {
    renderPlayground();
    expect(screen.queryByLabelText("Assistant")).toBeNull();
  });
});

describe("ProjectPlayground hotkeys", () => {
  /** Fires a chord on the document, where useHotkeys listens. */
  function chord(key: string, options: KeyboardEventInit = {}) {
    fireEvent.keyDown(document, { key, ctrlKey: true, ...options });
  }

  it("toggles the sidebar on Ctrl+B", () => {
    renderPlayground();
    chord("b");
    expect(screen.queryByTestId("tree")).toBeNull();
  });

  it("toggles the preview on Ctrl+J", () => {
    renderPlayground();
    chord("j");
    expect(screen.getByTestId("preview")).toBeDefined();
  });

  it("opens search on Ctrl+Shift+F", () => {
    renderPlayground();
    chord("f", { shiftKey: true });
    expect(screen.getByTestId("search-panel")).toBeDefined();
  });

  it("opens the command palette on Ctrl+Shift+P, not quick open", () => {
    renderPlayground();
    chord("p", { shiftKey: true });

    expect(screen.getByPlaceholderText("Run a command…")).toBeDefined();
    expect(screen.queryByPlaceholderText("Go to file…")).toBeNull();
  });

  it("opens quick open on plain Ctrl+P", () => {
    renderPlayground();
    chord("p");

    expect(screen.getByPlaceholderText("Go to file…")).toBeDefined();
    expect(screen.queryByPlaceholderText("Run a command…")).toBeNull();
  });
});

describe("ProjectPlayground commands", () => {
  function openPalette(level: "viewer" | "editor" | "owner" = "owner") {
    renderPlayground();
    grantAccess(level);
    fireEvent.keyDown(document, { key: "p", ctrlKey: true, shiftKey: true });
  }

  it("starts the dev server through the palette", () => {
    openPalette();
    fireEvent.click(screen.getByText("Start the dev server"));

    expect(emitted.some((entry) => entry.event === "runStart")).toBe(true);
  });

  it("offers to stop it once it is running", () => {
    act(() => {
      useRunStore.setState({ state: { status: "running" } });
    });
    openPalette();

    fireEvent.click(screen.getByText("Stop the dev server"));
    expect(emitted.some((entry) => entry.event === "runStop")).toBe(true);
  });

  it("will not let a viewer run anything", () => {
    openPalette("viewer");

    fireEvent.click(screen.getByText("Start the dev server"));

    expect(emitted.some((entry) => entry.event === "runStart")).toBe(false);
    expect(screen.getAllByText("Needs edit access").length).toBeGreaterThan(0);
  });

  it("refuses to restart when nothing is running", () => {
    openPalette();
    fireEvent.click(screen.getByText("Restart the dev server"));

    expect(emitted.some((entry) => entry.event === "runRestart")).toBe(false);
  });

  it("toggles the preview through the palette", () => {
    openPalette();
    fireEvent.click(screen.getByText("Toggle the preview"));

    expect(screen.getByTestId("preview")).toBeDefined();
  });
});

describe("ProjectPlayground banners", () => {
  it("reports a socket error, and lets it be dismissed", () => {
    renderPlayground();

    act(() => {
      useEditorSocketStore.setState({ lastError: "Could not write the file" });
    });
    expect(screen.getByText("Could not write the file")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(useEditorSocketStore.getState().lastError).toBeNull();
  });

  it("warns that an open file changed on disk", () => {
    renderPlayground();

    act(() => {
      useEditorSocketStore.setState({ externallyChanged: ["src/App.tsx"] });
    });

    expect(screen.getByText(/src\/App\.tsx.*changed on disk/)).toBeDefined();
  });

  it("summarises rather than listing every externally changed file", () => {
    renderPlayground();

    act(() => {
      useEditorSocketStore.setState({
        externallyChanged: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      });
    });

    expect(screen.getByText(/and 2 more/)).toBeDefined();
  });
});

describe("ProjectPlayground language service", () => {
  it("asks the server for the project's sources", () => {
    renderPlayground();

    expect(emitted.some((entry) => entry.event === "projectSources")).toBe(true);
  });

  it("hands them to Monaco when they arrive", async () => {
    renderPlayground();

    const files = [{ relPath: "src/util.ts", contents: "export const one = 1;" }];
    act(() => {
      handlers.get("projectSources")?.({ files, truncated: false });
    });

    await waitFor(() => {
      expect(installProjectSources).toHaveBeenCalledWith({ fake: "monaco" }, files);
    });
  });

  it("drops them when the project is left", () => {
    const { unmount } = renderPlayground();
    unmount();

    // Otherwise a lookup could land in a file from the previous project.
    expect(clearProjectSources).toHaveBeenCalled();
  });
});
