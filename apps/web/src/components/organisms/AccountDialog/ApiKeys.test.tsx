// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiKeySummary } from "@replit-clone/shared";

const listKeys = vi.fn();
const createKey = vi.fn();
const revokeKey = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  listApiKeysApi: () => listKeys() as unknown,
  createApiKeyApi: (input: unknown) => createKey(input) as unknown,
  revokeApiKeyApi: (id: string) => revokeKey(id) as unknown,
}));

import { ApiKeys } from "./ApiKeys.tsx";

function key(over: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "k1",
    label: "CI",
    prefix: "rc_abcdef012345",
    scopes: ["deploy"],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-08-30T09:00:00.000Z",
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ApiKeys />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listKeys.mockReset().mockResolvedValue([]);
  createKey.mockReset().mockResolvedValue({
    key: key(),
    secret: "rc_abcdef012345_0123456789abcdef",
  });
  revokeKey.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("making a key", () => {
  /** Nothing is ticked by default. A form that pre-selects everything teaches
   *  people to click through it, and this is the screen where that matters
   *  most: the result is a long-lived credential on a machine. */
  it("will not create one until it is named and scoped", async () => {
    show();

    fireEvent.click(await screen.findByRole("button", { name: /new key/i }));

    const create = screen.getByRole("button", { name: /create key/i });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Key name"), {
      target: { value: "Deploy from CI" },
    });
    // Named but unscoped is still not enough.
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByText("Publish deployments"));
    expect(create.hasAttribute("disabled")).toBe(false);

    fireEvent.click(create);

    await waitFor(() => {
      expect(createKey).toHaveBeenCalledWith({
        label: "Deploy from CI",
        scopes: ["deploy"],
      });
    });
  });

  /** The secret is not recoverable, so it stays on screen until dismissed —
   *  a toast that vanishes in three seconds is a key somebody has to re-mint. */
  it("shows the secret once, and says that this is the only time", async () => {
    show();

    fireEvent.click(await screen.findByRole("button", { name: /new key/i }));
    fireEvent.change(screen.getByLabelText("Key name"), {
      target: { value: "CI" },
    });
    fireEvent.click(screen.getByText("Publish deployments"));
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    expect(
      await screen.findByText("rc_abcdef012345_0123456789abcdef"),
    ).toBeTruthy();
    expect(screen.getByText(/only time it will be shown/i)).toBeTruthy();
  });
});

describe("the list", () => {
  it("says when a key has never been used", async () => {
    listKeys.mockResolvedValue([key()]);
    show();

    expect(await screen.findByText(/never used/i)).toBeTruthy();
  });

  /** The question `lastUsedAt` answers is what makes revoking an unfamiliar
   *  key safe to do rather than a gamble. */
  it("says when it was last used", async () => {
    listKeys.mockResolvedValue([
      key({ lastUsedAt: "2026-08-31T09:00:00.000Z" }),
    ]);
    show();

    expect(await screen.findByText(/last used/i)).toBeTruthy();
  });

  /** A revoked key stays listed: "that key was revoked on Tuesday" is the
   *  sentence somebody needs after an incident. */
  it("keeps a revoked key, and stops offering to revoke it", async () => {
    listKeys.mockResolvedValue([
      key({ revokedAt: "2026-08-31T09:00:00.000Z" }),
    ]);
    show();

    expect(await screen.findByText(/revoked /i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^revoke$/i })).toBeNull();
  });

  it("never shows a whole secret, only the public half", async () => {
    listKeys.mockResolvedValue([key()]);
    show();

    expect(await screen.findByText(/rc_abcdef012345/)).toBeTruthy();
    expect(screen.queryByText(/0123456789abcdef/)).toBeNull();
  });

  it("says so when there are none", async () => {
    show();

    expect(await screen.findByText(/no keys yet/i)).toBeTruthy();
  });

  it("does not render a failure as an empty list", async () => {
    listKeys.mockRejectedValue(new Error("500"));
    show();

    expect(
      await screen.findByText(/could not load this account's api keys/i),
    ).toBeTruthy();
  });
});

/** What a key can reach is a security claim, and the person creating one is
 *  entitled to read it without going to look for documentation. */
describe("what the screen promises", () => {
  it("says what a key cannot do", async () => {
    show();

    expect(await screen.findByText(/cannot delete anything/i)).toBeTruthy();
    expect(screen.getByText(/cannot make another key/i)).toBeTruthy();
  });
});
