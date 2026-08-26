// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GithubConnectionCard } from "./GithubConnectionCard.tsx";

const api = vi.hoisted(() => ({
  getGithubStatusApi: vi.fn(),
  startGithubConnectApi: vi.fn(),
  disconnectGithubApi: vi.fn(),
}));
vi.mock("../../../apis/github.ts", () => api);

const navigateAway = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/navigateAway.ts", () => ({ navigateAway }));

const CONNECTED = {
  configured: true,
  connection: {
    login: "octocat",
    scopes: ["repo", "read:user"],
    connectedAt: "2026-01-01T00:00:00.000Z",
    canUseRepos: true,
  },
};

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <GithubConnectionCard open onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getGithubStatusApi.mockResolvedValue({ configured: true, connection: null });
  api.startGithubConnectApi.mockResolvedValue("https://github.com/login/oauth");
  api.disconnectGithubApi.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("when nothing is connected", () => {
  it("says what the extra access is for, not just that it is needed", async () => {
    renderCard();

    expect(
      await screen.findByRole("button", { name: /Connect GitHub/ }),
    ).toBeDefined();
    // The consent is separate from signing in, and asks for more; saying so is
    // the difference between an informed yes and a reflexive one.
    expect(screen.getByText(/separate from signing in/)).toBeDefined();
  });

  it("sends the browser to the URL the server hands back", async () => {
    renderCard();
    // Waits for the status query to settle first: while it is in flight the
    // button is in antd's loading state, which ignores clicks.
    // The button only exists once the status is known, so finding it is the
    // wait: before that the dialog shows a spinner rather than guessing.
    const button = await screen.findByRole("button", { name: /Connect GitHub/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(navigateAway).toHaveBeenCalledWith("https://github.com/login/oauth");
    });
  });
});

describe("when connected", () => {
  it("names the account and offers to disconnect", async () => {
    api.getGithubStatusApi.mockResolvedValue(CONNECTED);
    renderCard();

    expect(await screen.findByText("octocat")).toBeDefined();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDefined();
  });

  it("disconnects on request", async () => {
    api.getGithubStatusApi.mockResolvedValue(CONNECTED);
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(api.disconnectGithubApi).toHaveBeenCalled();
    });
  });

  it("warns when GitHub granted less than was asked for", async () => {
    // An organisation can withhold `repo`. Saying so here beats failing at the
    // first import with an error nobody can connect to the cause.
    api.getGithubStatusApi.mockResolvedValue({
      configured: true,
      connection: { ...CONNECTED.connection, scopes: ["read:user"], canUseRepos: false },
    });
    renderCard();

    expect(
      await screen.findByText(/No repository access was granted/),
    ).toBeDefined();
  });
});

describe("when the server does not offer it", () => {
  it("says what an operator would have to set", async () => {
    api.getGithubStatusApi.mockResolvedValue({ configured: false, connection: null });
    renderCard();

    expect(await screen.findByText(/Not configured on this server/)).toBeDefined();
    expect(screen.getByText(/SECRET_ENCRYPTION_KEY/)).toBeDefined();
  });

  it("offers no connect button, which could not work", async () => {
    api.getGithubStatusApi.mockResolvedValue({ configured: false, connection: null });
    renderCard();

    await screen.findByText(/Not configured/);
    expect(screen.queryByRole("button", { name: /Connect GitHub/ })).toBeNull();
  });
});
