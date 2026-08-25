// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { GitStatus } from "@replit-clone/shared";
import { SourceControlPanel } from "./SourceControlPanel.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";

const PROJECT = "p1";

const STATUS: GitStatus = {
  isRepo: true,
  branch: "main",
  changes: [
    { path: "src/App.tsx", unstaged: "modified" },
    { path: "src/new.ts", staged: "added" },
  ],
};

const PATCH = `diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,2 +1,2 @@
 kept line
-was this
+is now this
`;

// Hoisted so the mock factory below -- which vitest lifts above the imports --
// can hand back these exact spies rather than wrappers that erase their types.
const api = vi.hoisted(() => ({
  getGitStatusApi: vi.fn(),
  getGitLogApi: vi.fn(),
  getGitDiffApi: vi.fn(),
  gitStageApi: vi.fn(),
  gitUnstageApi: vi.fn(),
  gitCommitApi: vi.fn(),
  gitInitApi: vi.fn(),
}));

vi.mock("../../../apis/projects.ts", () => api);

const { getGitStatusApi, getGitLogApi, getGitDiffApi } = api;

const emitted: { event: string; payload: unknown }[] = [];

beforeEach(() => {
  emitted.length = 0;
  getGitStatusApi.mockResolvedValue(STATUS);
  getGitLogApi.mockResolvedValue([]);
  getGitDiffApi.mockResolvedValue(PATCH);

  useEditorSocketStore.setState({
    editorSocket: {
      on: vi.fn(),
      off: vi.fn(),
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
      // The panel only ever uses the three above.
    } as never,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Waits for the initial status load to land. */
async function renderPanel(canWrite = true) {
  render(<SourceControlPanel projectId={PROJECT} canWrite={canWrite} />);
  expect(await screen.findByText("App.tsx")).toBeDefined();
}

describe("SourceControlPanel diffs", () => {
  it("shows no diff until a row is clicked", async () => {
    await renderPanel();
    expect(getGitDiffApi).not.toHaveBeenCalled();
  });

  it("expands the diff for the clicked file", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));

    await waitFor(() => {
      expect(getGitDiffApi).toHaveBeenCalledWith(PROJECT, "src/App.tsx", false);
    });

    // The patch's own lines, not the header noise around them.
    expect(await screen.findByText("is now this")).toBeDefined();
    expect(screen.getByText("was this")).toBeDefined();
    expect(screen.getByText("kept line")).toBeDefined();
  });

  it("asks for the staged side when the row is a staged one", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("new.ts"));

    await waitFor(() => {
      expect(getGitDiffApi).toHaveBeenCalledWith(PROJECT, "src/new.ts", true);
    });
  });

  it("collapses again when the same row is clicked twice", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));
    expect(await screen.findByText("is now this")).toBeDefined();

    fireEvent.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(screen.queryByText("is now this")).toBeNull();
    });
  });

  it("shows one diff at a time", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));
    expect(await screen.findByText("is now this")).toBeDefined();

    fireEvent.click(screen.getByText("new.ts"));
    await waitFor(() => {
      expect(screen.queryByText("is now this")).toBeNull();
    });
  });

  it("summarises the change counts", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText("+1")).toBeDefined();
    expect(screen.getByText("−1")).toBeDefined();
  });

  it("reports a diff that could not be loaded", async () => {
    getGitDiffApi.mockRejectedValue(new Error("gone"));
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText("Could not load the diff")).toBeDefined();
  });

  it("says so when a binary file has nothing to show", async () => {
    getGitDiffApi.mockResolvedValue(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    );
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText(/Binary file/)).toBeDefined();
  });

  it("opens the file from the icon, without expanding the diff", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTitle("Open App.tsx"));

    expect(emitted).toContainEqual({
      event: "readFile",
      payload: { relPath: "src/App.tsx" },
    });
    // The icon is not the row: clicking it must not also open the diff.
    expect(getGitDiffApi).not.toHaveBeenCalled();
  });

  it("still lets a viewer read a diff", async () => {
    await renderPanel(false);
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText("is now this")).toBeDefined();
  });
});
