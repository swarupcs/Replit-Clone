// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccountSshKeys } from "@replit-clone/shared";

const getKeys = vi.fn();
const setKeys = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  getSshKeysApi: () => getKeys() as unknown,
  setSshKeysApi: (lines: string[]) => setKeys(lines) as unknown,
}));

import { SshKeys } from "./SshKeys.tsx";

const LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI me@laptop";

function state(over: Partial<AccountSshKeys> = {}): AccountSshKeys {
  return {
    keys: [
      {
        line: LINE,
        type: "ssh-ed25519",
        comment: "me@laptop",
        fingerprint: "SHA256:abc123",
      },
    ],
    enabled: true,
    ...over,
  };
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SshKeys />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getKeys.mockReset().mockResolvedValue(state());
  setKeys.mockReset().mockImplementation(() => Promise.resolve(state({ keys: [] })));
});

afterEach(() => {
  cleanup();
});

describe("the SSH keys panel", () => {
  it("shows the fingerprint, not the key", async () => {
    show();
    // The form somebody can compare against `ssh-keygen -lf` on the machine
    // the key came from, without trusting this screen.
    expect(await screen.findByText("SHA256:abc123")).toBeTruthy();
  });

  it("adds a pasted key to what is stored", async () => {
    show();
    await screen.findByText("SHA256:abc123");

    fireEvent.change(screen.getByLabelText("New public key"), {
      target: { value: "ssh-ed25519 BBBB other@host" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    // Appended, not replacing: the box is for adding and the bin icons are for
    // removing.
    await waitFor(() => {
      expect(setKeys).toHaveBeenCalledWith([LINE, "ssh-ed25519 BBBB other@host"]);
    });
  });

  it("will not add an empty paste", async () => {
    show();
    await screen.findByText("SHA256:abc123");
    expect(
      screen.getByRole("button", { name: "Add key" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the remaining keys when one is removed", async () => {
    show();
    await screen.findByText("SHA256:abc123");

    fireEvent.click(screen.getByLabelText("Remove me@laptop"));

    await waitFor(() => {
      expect(setKeys).toHaveBeenCalledWith([]);
    });
  });

  it("says so when the server will ignore the keys", async () => {
    // A panel that accepts keys on a server that ignores them is a panel that
    // lies.
    getKeys.mockResolvedValue(state({ enabled: false }));
    show();

    expect(await screen.findByText("Not turned on for this server")).toBeTruthy();
  });

  it("says nothing about that when the server does accept them", async () => {
    show();
    await screen.findByText("SHA256:abc123");
    expect(screen.queryByText("Not turned on for this server")).toBeNull();
  });
});
