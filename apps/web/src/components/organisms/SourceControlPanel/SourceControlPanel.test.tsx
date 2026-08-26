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
  getGitBranchesApi: vi.fn(),
  gitBranchApi: vi.fn(),
  gitDiscardApi: vi.fn(),
  gitHunksApi: vi.fn(),
  getGitRemotesApi: vi.fn(),
  gitRemoteApi: vi.fn(),
  gitFetchApi: vi.fn(),
  gitPullApi: vi.fn(),
  gitPushApi: vi.fn(),
  gitStageApi: vi.fn(),
  gitUnstageApi: vi.fn(),
  gitCommitApi: vi.fn(),
  gitInitApi: vi.fn(),
}));

vi.mock("../../../apis/projects.ts", () => api);

/** The panel asks whether a connected GitHub account could supply the push
 *  credential. Mocked so the suite makes no real request, and so both answers
 *  can be exercised. */
const getGithubStatusApi = vi.hoisted(() => vi.fn());
vi.mock("../../../apis/github.ts", () => ({ getGithubStatusApi }));

const {
  getGitStatusApi,
  getGitLogApi,
  getGitDiffApi,
  getGitBranchesApi,
  gitBranchApi,
  gitDiscardApi,
  gitHunksApi,
  getGitRemotesApi,
  gitFetchApi,
  gitPullApi,
  gitPushApi,
} = api;

const BRANCHES = [
  { name: "main", current: true },
  { name: "feature", current: false },
];

/** antd's static `message` renders through its own portal and needs app
 *  context, so what it was ASKED to say is asserted instead of what it drew. */
const messageError = vi.hoisted(() => vi.fn());
vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { ...actual.message, error: messageError },
  };
});

const emitted: { event: string; payload: unknown }[] = [];

beforeEach(() => {
  emitted.length = 0;
  getGithubStatusApi.mockResolvedValue({ configured: true, connection: null });
  getGitStatusApi.mockResolvedValue(STATUS);
  getGitLogApi.mockResolvedValue([]);
  getGitDiffApi.mockResolvedValue(PATCH);
  getGitBranchesApi.mockResolvedValue(BRANCHES);
  gitDiscardApi.mockResolvedValue({ ...STATUS, changes: [] });
  gitHunksApi.mockResolvedValue(STATUS);
  getGitRemotesApi.mockResolvedValue([
    { name: "origin", url: "https://github.com/a/b.git" },
  ]);
  gitFetchApi.mockResolvedValue(STATUS);
  gitPullApi.mockResolvedValue(STATUS);
  gitPushApi.mockResolvedValue(STATUS);
  gitBranchApi.mockResolvedValue({
    status: { ...STATUS, branch: "feature" },
    branches: [
      { name: "main", current: false },
      { name: "feature", current: true },
    ],
  });

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

/** Waits for the initial status load to land.
 *
 *  Owner by default, since that is the ordinary case; the tests that care
 *  about the difference pass it explicitly. */
async function renderPanel(canWrite = true, isOwner = canWrite) {
  render(
    <SourceControlPanel
      projectId={PROJECT}
      canWrite={canWrite}
      isOwner={isOwner}
    />,
  );
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
    fireEvent.click(screen.getByLabelText("Open App.tsx"));

    expect(emitted).toContainEqual({
      event: "readFile",
      payload: { relPath: "src/App.tsx" },
    });
    // The icon is not the row: clicking it must not also open the diff.
    expect(getGitDiffApi).not.toHaveBeenCalled();
  });

  /** The row holds buttons of its own — stage, discard — so it could not be
   *  one, and it was a div with a click handler: the diff was mouse-only. Its
   *  two actions are sibling buttons now. */
  it("makes the row's two actions real buttons", async () => {
    await renderPanel();

    // The two are distinct controls, so each is asked for on its own terms:
    // the icon by its label, the row by the filename it shows.
    const open = screen.getByLabelText("Open App.tsx");
    const label = screen.getByText("App.tsx").closest("button");

    expect(open.tagName).toBe("BUTTON");
    expect(label).not.toBeNull();
    expect(label).not.toBe(open);
    // Announces that the row expands, and reflects whether it currently is.
    expect(label?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByText("App.tsx"));
    expect(await screen.findByText("is now this")).toBeDefined();
    expect(label?.getAttribute("aria-expanded")).toBe("true");
  });

  it("still lets a viewer read a diff", async () => {
    await renderPanel(false);
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText("is now this")).toBeDefined();
  });
});

describe("SourceControlPanel branches", () => {
  /** Opens the branch picker, which is the current branch's own button. */
  async function openPicker() {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("Switch branch"));
  }

  it("shows the current branch", async () => {
    await renderPanel();
    expect(screen.getByLabelText("Switch branch").textContent).toContain("main");
  });

  it("lists the other branches, but not the current one", async () => {
    await openPicker();

    expect(await screen.findByText("feature")).toBeDefined();
    // "main" is the button's own label, not a menu entry to switch to.
    expect(screen.getAllByText("main")).toHaveLength(1);
  });

  it("switches when one is picked", async () => {
    await openPicker();
    fireEvent.click(await screen.findByText("feature"));

    await waitFor(() => {
      expect(gitBranchApi).toHaveBeenCalledWith(PROJECT, "feature", false);
    });
  });

  it("shows the new branch as current afterwards", async () => {
    await openPicker();
    fireEvent.click(await screen.findByText("feature"));

    await waitFor(() => {
      expect(screen.getByLabelText("Switch branch").textContent).toContain(
        "feature",
      );
    });
  });

  it("reports the server's reason for refusing, not the status code", async () => {
    gitBranchApi.mockRejectedValue({
      response: {
        data: {
          message: "Commit or discard your changes before switching branch",
        },
      },
    });

    await openPicker();
    fireEvent.click(await screen.findByText("feature"));

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith(
        "Commit or discard your changes before switching branch",
      );
    });
  });

  it("falls back to its own wording when the server sent no message", async () => {
    gitBranchApi.mockRejectedValue(new Error("Network Error"));

    await openPicker();
    fireEvent.click(await screen.findByText("feature"));

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith("Network Error");
    });
  });

  it("creates a branch from the dialog", async () => {
    await openPicker();
    fireEvent.click(await screen.findByText("New branch…"));

    fireEvent.change(
      await screen.findByPlaceholderText("feature/what-you-are-doing"),
      { target: { value: "feature/new" } },
    );
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(gitBranchApi).toHaveBeenCalledWith(PROJECT, "feature/new", true);
    });
  });

  it("will not create a branch with no name", async () => {
    await openPicker();
    fireEvent.click(await screen.findByText("New branch…"));

    fireEvent.change(
      await screen.findByPlaceholderText("feature/what-you-are-doing"),
      { target: { value: "   " } },
    );
    fireEvent.click(screen.getByText("Create"));

    expect(gitBranchApi).not.toHaveBeenCalled();
  });

  it("gives a viewer no way to change branch", async () => {
    await renderPanel(false);

    expect(screen.queryByLabelText("Switch branch")).toBeNull();
    // The branch is still shown, just not as a control.
    expect(screen.getByText("main")).toBeDefined();
  });
});

describe("SourceControlPanel discarding", () => {
  const DISCARD_LABEL = "Discard changes to src/App.tsx";

  it("does nothing until the confirmation is accepted", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    expect(await screen.findByText("Discard changes?")).toBeDefined();
    expect(gitDiscardApi).not.toHaveBeenCalled();
  });

  it("says the change cannot be undone", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    expect(await screen.findByText(/cannot be undone/)).toBeDefined();
  });

  it("discards once confirmed", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Discard",
    );
    fireEvent.click(confirm as HTMLElement);

    await waitFor(() => {
      expect(gitDiscardApi).toHaveBeenCalledWith(PROJECT, ["src/App.tsx"]);
    });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    fireEvent.click(cancel as HTMLElement);

    expect(gitDiscardApi).not.toHaveBeenCalled();
  });

  it("warns that a new file is deleted rather than reverted", async () => {
    getGitStatusApi.mockResolvedValue({
      ...STATUS,
      changes: [{ path: "src/App.tsx", unstaged: "untracked" }],
    });
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    expect(await screen.findByText(/it is deleted/)).toBeDefined();
  });

  it("offers no discard on a staged row, where unstage is the way back", async () => {
    await renderPanel();

    expect(screen.queryByLabelText("Discard changes to src/new.ts")).toBeNull();
  });

  it("gives a viewer no way to discard anything", async () => {
    await renderPanel(false);

    expect(screen.queryByLabelText(DISCARD_LABEL)).toBeNull();
  });

  it("does not open the file's diff when the discard button is clicked", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText(DISCARD_LABEL));

    expect(getGitDiffApi).not.toHaveBeenCalled();
  });
});

describe("SourceControlPanel hunk staging", () => {
  /** The unstaged file's diff, open. */
  async function openDiff() {
    await renderPanel();
    fireEvent.click(screen.getByText("App.tsx"));
    return screen.findByText("is now this");
  }

  it("offers to stage each hunk of an unstaged file", async () => {
    await openDiff();

    expect(
      await screen.findByLabelText("Stage hunk 1 of src/App.tsx"),
    ).toBeDefined();
  });

  it("stages the hunk it was asked for", async () => {
    await openDiff();
    fireEvent.click(await screen.findByLabelText("Stage hunk 1 of src/App.tsx"));

    await waitFor(() => {
      expect(gitHunksApi).toHaveBeenCalledWith(
        PROJECT,
        "src/App.tsx",
        [0],
        false,
      );
    });
  });

  it("re-reads the diff afterwards, since the patch has changed", async () => {
    await openDiff();
    const before = getGitDiffApi.mock.calls.length;

    fireEvent.click(await screen.findByLabelText("Stage hunk 1 of src/App.tsx"));

    await waitFor(() => {
      expect(getGitDiffApi.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("unstages from a staged row's diff instead", async () => {
    await renderPanel();
    fireEvent.click(screen.getByText("new.ts"));

    fireEvent.click(await screen.findByLabelText("Unstage hunk 1 of src/new.ts"));

    await waitFor(() => {
      expect(gitHunksApi).toHaveBeenCalledWith(PROJECT, "src/new.ts", [0], true);
    });
  });

  it("reports the server's reason when a hunk will not apply", async () => {
    gitHunksApi.mockRejectedValue({
      response: { data: { message: "Those changes are no longer there" } },
    });

    await openDiff();
    fireEvent.click(await screen.findByLabelText("Stage hunk 1 of src/App.tsx"));

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith(
        "Those changes are no longer there",
      );
    });
  });

  it("gives a viewer a readable diff with no staging buttons", async () => {
    await renderPanel(false);
    fireEvent.click(screen.getByText("App.tsx"));

    expect(await screen.findByText("is now this")).toBeDefined();
    expect(screen.queryByLabelText("Stage hunk 1 of src/App.tsx")).toBeNull();
  });
});

describe("SourceControlPanel remotes", () => {
  async function openRemotes() {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("Remotes"));
  }

  it("offers fetch and pull per remote", async () => {
    await openRemotes();

    expect(await screen.findByText("Fetch from origin")).toBeDefined();
    expect(screen.getByText("Pull from origin")).toBeDefined();
  });

  it("offers push only to the owner, whose credential it would spend", async () => {
    // Superseded an earlier "never offers to push": pushing exists now, but
    // only for a project the owner has to themselves. The server refuses a
    // shared one outright -- see the pushing suite below.
    await openRemotes();

    expect(await screen.findByText("Push to origin…")).toBeDefined();
  });

  it("fetches from the chosen remote", async () => {
    await openRemotes();
    fireEvent.click(await screen.findByText("Fetch from origin"));

    await waitFor(() => {
      expect(gitFetchApi).toHaveBeenCalledWith(PROJECT, "origin");
    });
  });

  it("pulls the current branch", async () => {
    await openRemotes();
    fireEvent.click(await screen.findByText("Pull from origin"));

    await waitFor(() => {
      expect(gitPullApi).toHaveBeenCalledWith(PROJECT, "origin", "main");
    });
  });

  it("reports the server's reason for refusing a pull", async () => {
    gitPullApi.mockRejectedValue({
      response: {
        data: { message: "Commit or discard your changes before pulling" },
      },
    });

    await openRemotes();
    fireEvent.click(await screen.findByText("Pull from origin"));

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith(
        "Commit or discard your changes before pulling",
      );
    });
  });

  it("shows no remote control when there are none", async () => {
    getGitRemotesApi.mockResolvedValue([]);
    await renderPanel();

    expect(screen.queryByLabelText("Remotes")).toBeNull();
  });

  it("gives a viewer no remote control", async () => {
    await renderPanel(false);

    expect(screen.queryByLabelText("Remotes")).toBeNull();
  });
});

describe("SourceControlPanel pushing", () => {
  /** Opens the remotes menu as the given role. */
  async function openRemotesAs(isOwner: boolean) {
    await renderPanel(true, isOwner);
    fireEvent.click(screen.getByLabelText("Remotes"));
  }

  /** Opens the push dialog for origin. */
  async function openPush() {
    await openRemotesAs(true);
    fireEvent.click(await screen.findByText("Push to origin…"));
    return screen.findByPlaceholderText("Access token");
  }

  it("offers pushing to the owner", async () => {
    await openRemotesAs(true);
    expect(await screen.findByText("Push to origin…")).toBeDefined();
  });

  it("does not offer it to an editor who is not the owner", async () => {
    // The credential would be the owner's, not theirs.
    await openRemotesAs(false);

    expect(await screen.findByText("Fetch from origin")).toBeDefined();
    expect(screen.queryByText("Push to origin…")).toBeNull();
  });

  it("asks for a token rather than pushing straight away", async () => {
    await openPush();
    expect(gitPushApi).not.toHaveBeenCalled();
  });

  it("says the token is not saved anywhere", async () => {
    await openPush();
    expect(screen.getByText(/not saved here, in the repository, or/)).toBeDefined();
  });

  it("pushes the current branch with the token given", async () => {
    const input = await openPush();
    fireEvent.change(input, { target: { value: "a-token" } });
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      expect(gitPushApi).toHaveBeenCalledWith(
        PROJECT,
        "origin",
        "main",
        "a-token",
      );
    });
  });

  it("will not push with an empty token", async () => {
    const input = await openPush();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Push"));

    expect(gitPushApi).not.toHaveBeenCalled();
  });

  it("forgets the token when the dialog is cancelled", async () => {
    const input = await openPush();
    fireEvent.change(input, { target: { value: "a-token" } });
    fireEvent.click(screen.getByText("Cancel"));

    // Reopening must not present the previous one.
    fireEvent.click(screen.getByLabelText("Remotes"));
    fireEvent.click(await screen.findByText("Push to origin…"));

    // A controlled input carries its value as a property, not an attribute.
    const reopened =
      await screen.findByPlaceholderText<HTMLInputElement>("Access token");
    expect(reopened.value).toBe("");
  });

  it("reports the server's reason for refusing a shared project", async () => {
    gitPushApi.mockRejectedValue({
      response: {
        data: {
          message:
            "This project is shared, so a token used here would be readable by everyone with access. Push from the project's terminal instead.",
        },
      },
    });

    const input = await openPush();
    fireEvent.change(input, { target: { value: "a-token" } });
    fireEvent.click(screen.getByText("Push"));

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith(
        expect.stringContaining("Push from the project's terminal instead."),
      );
    });
  });
});


/** Pushing used to demand a token typed in every time. A connected GitHub
 *  account supplies one; pasting remains the way to push anywhere else. */
describe("SourceControlPanel pushing with a connection", () => {
  async function openPush() {
    fireEvent.click(screen.getByLabelText("Remotes"));
    fireEvent.click(await screen.findByText(/Push to origin/));
  }

  it("stops asking for a token when one can be supplied", async () => {
    getGithubStatusApi.mockResolvedValue({
      configured: true,
      connection: {
        login: "octocat",
        scopes: ["repo"],
        connectedAt: "2026-01-01T00:00:00.000Z",
        canUseRepos: true,
      },
    });
    await renderPanel();
    await openPush();

    expect(
      await screen.findByText(/Pushing as your connected GitHub account/),
    ).toBeDefined();
    expect(screen.queryByPlaceholderText("Access token")).toBeNull();
  });

  it("pushes with no token at all in that case", async () => {
    getGithubStatusApi.mockResolvedValue({
      configured: true,
      connection: {
        login: "octocat",
        scopes: ["repo"],
        connectedAt: "2026-01-01T00:00:00.000Z",
        canUseRepos: true,
      },
    });
    await renderPanel();
    await openPush();
    await screen.findByText(/Pushing as your connected GitHub account/);

    fireEvent.click(screen.getByRole("button", { name: "Push" }));

    await waitFor(() => {
      expect(gitPushApi).toHaveBeenCalledWith(PROJECT, "origin", "main", undefined);
    });
  });

  it("still asks when there is no connection", async () => {
    // Pasting a token is how anyone pushes to a forge this server knows
    // nothing about, and it stays possible.
    await renderPanel();
    await openPush();

    expect(await screen.findByPlaceholderText("Access token")).toBeDefined();
  });

  it("still asks when GitHub granted no repository access", async () => {
    getGithubStatusApi.mockResolvedValue({
      configured: true,
      connection: {
        login: "octocat",
        scopes: ["read:user"],
        connectedAt: "2026-01-01T00:00:00.000Z",
        canUseRepos: false,
      },
    });
    await renderPanel();
    await openPush();

    expect(await screen.findByPlaceholderText("Access token")).toBeDefined();
  });
});
