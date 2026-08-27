// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportRepoDialog } from "./ImportRepoDialog.tsx";

const api = vi.hoisted(() => ({
  getGithubStatusApi: vi.fn(),
  listGithubReposApi: vi.fn(),
  importGithubRepoApi: vi.fn(),
}));
vi.mock("../../../apis/github.ts", () => api);

const CONNECTED = {
  configured: true,
  connection: {
    login: "octocat",
    scopes: ["repo"],
    connectedAt: "2026-01-01T00:00:00.000Z",
    canUseRepos: true,
  },
};

const REPOS = [
  {
    id: 1,
    fullName: "octocat/hello",
    owner: "octocat",
    name: "hello",
    private: false,
    description: "a greeting",
    defaultBranch: "main",
    sizeKb: 100,
    language: "TypeScript",
    pushedAt: null,
  },
  {
    id: 2,
    fullName: "octocat/secret",
    owner: "octocat",
    name: "secret",
    private: true,
    description: null,
    defaultBranch: "main",
    sizeKb: 50,
    language: null,
    pushedAt: null,
  },
];

const onImported = vi.fn();
const onConnect = vi.fn();

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ImportRepoDialog
        open
        onClose={() => undefined}
        onImported={onImported}
        onConnect={onConnect}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getGithubStatusApi.mockResolvedValue(CONNECTED);
  api.listGithubReposApi.mockResolvedValue({ repos: REPOS, hasMore: false });
  api.importGithubRepoApi.mockResolvedValue({ id: "p1", name: "hello" });
});

afterEach(() => {
  cleanup();
  // A safety net: a test that installs fake timers and then fails before
  // restoring them leaves every later `waitFor` unable to advance, which shows
  // up as four unrelated timeouts.
  vi.useRealTimers();
});

describe("when GitHub is not connected", () => {
  it("offers to connect rather than an empty list", async () => {
    // The first render in this file pays for antd's and react-query's cold
    // start, which on a loaded machine is more than the 5s default -- so this
    // one test fails while every later one in the same file passes. Given the
    // time it actually takes rather than left to fail intermittently.
    api.getGithubStatusApi.mockResolvedValue({ configured: true, connection: null });
    renderDialog();

    expect(await screen.findByText(/Connect GitHub first/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Connect GitHub/ }));
    expect(onConnect).toHaveBeenCalled();
  }, 20_000);

  it("does not ask for repositories, which would be a guaranteed failure", async () => {
    api.getGithubStatusApi.mockResolvedValue({ configured: true, connection: null });
    renderDialog();

    await screen.findByText(/Connect GitHub first/);
    expect(api.listGithubReposApi).not.toHaveBeenCalled();
  });

  it("treats a connection without repo scope as not connected", async () => {
    // An organisation can withhold it. The list would come back empty or
    // failing, neither of which explains itself.
    api.getGithubStatusApi.mockResolvedValue({
      configured: true,
      connection: { ...CONNECTED.connection, scopes: ["read:user"], canUseRepos: false },
    });
    renderDialog();

    expect(await screen.findByText(/Connect GitHub first/)).toBeDefined();
  });
});

describe("the repository list", () => {
  it("shows each repository and marks the private ones", async () => {
    renderDialog();

    expect(await screen.findByText("octocat/hello")).toBeDefined();
    expect(screen.getByText("octocat/secret")).toBeDefined();
    expect(screen.getByText("a greeting")).toBeDefined();
  });

  it("searches on the server rather than filtering what loaded", async () => {
    renderDialog();
    await screen.findByText("octocat/hello");

    fireEvent.change(screen.getByPlaceholderText(/Search your repositories/), {
      target: { value: "secret" },
    });

    // Real timers, and a window wider than the 300ms debounce. Fake ones would
    // have to be threaded through react-query's own scheduling as well, which
    // buys nothing here.
    await waitFor(
      () => {
        expect(api.listGithubReposApi).toHaveBeenCalledWith({ query: "secret" });
      },
      { timeout: 2000 },
    );
  });
});

describe("importing", () => {
  it("clones the chosen repository and hands back the project", async () => {
    renderDialog();
    await screen.findByText("octocat/hello");

    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]!);

    // The first argument, not the whole call: react-query hands a mutation
    // function a context beside the variables.
    await waitFor(() => {
      expect(api.importGithubRepoApi.mock.calls[0]?.[0]).toEqual({
        owner: "octocat",
        repo: "hello",
      });
    });
    await waitFor(() => {
      expect(onImported.mock.calls[0]?.[0]).toEqual({ id: "p1", name: "hello" });
    });
  });

  it("reports the server's reason for refusing", async () => {
    // "That repository is about 900 MB" is the whole point; "Request failed
    // with status code 400" is not.
    api.importGithubRepoApi.mockRejectedValue({
      response: { data: { message: "That repository is too large" } },
    });
    renderDialog();
    await screen.findByText("octocat/hello");

    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]!);

    expect(await screen.findByText("That repository is too large")).toBeDefined();
  });

  it("blocks the other rows while one is cloning", async () => {
    // A second clone would race the first for the quota and the disk.
    api.importGithubRepoApi.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    await screen.findByText("octocat/hello");

    const buttons = screen.getAllByRole("button", { name: "Import" });
    fireEvent.click(buttons[0]!);

    // `hasAttribute` rather than `toBeDisabled`: jest-dom's matchers are not
    // installed in this workspace.
    // Nothing is left to click: the row being cloned is in antd's loading
    // state, and every other row is disabled. Asserted over whatever is still
    // matchable rather than by index, since a loading button stops matching
    // the name.
    await waitFor(() => {
      const remaining = screen.getAllByRole("button", { name: "Import" });
      expect(remaining.every((button) => button.hasAttribute("disabled"))).toBe(
        true,
      );
    });
  });
});
