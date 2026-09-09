// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteAccess } from "@replit-clone/shared";

const getRemote = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  getRemoteAccessApi: () => getRemote() as unknown,
}));

import { RemoteAccessDialog } from "./RemoteAccessDialog.tsx";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RemoteAccessDialog projectId={PROJECT} open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const AVAILABLE: RemoteAccess = {
  available: true,
  host: "box.example",
  port: 49155,
  user: "sandbox",
  folder: "/home/sandbox/app",
  agentForwarding: true,
  command: "ssh -A -p 49155 sandbox@box.example",
  vscodeUri: "vscode://vscode-remote/ssh-remote+sandbox@box.example:49155/home/sandbox/app",
};

beforeEach(() => {
  getRemote.mockReset().mockResolvedValue(AVAILABLE);
});

afterEach(() => {
  cleanup();
});

describe("attaching your own editor", () => {
  it("shows the command to paste", async () => {
    show();
    expect(await screen.findByText("ssh -A -p 49155 sandbox@box.example")).toBeTruthy();
  });

  it("offers to open VS Code at the folder", async () => {
    show();
    const link = await screen.findByRole("link", { name: "Open in VS Code" });
    expect(link.getAttribute("href")).toContain("/home/sandbox/app");
  });

  it("says what to change when the server has it off", async () => {
    getRemote.mockResolvedValue({ available: false, reason: "disabled" });
    show();

    // Naming the variable, because the person who can fix this is the operator
    // and that is the word they will search for.
    expect(await screen.findByText(/SANDBOX_SSH_ENABLED/)).toBeTruthy();
  });

  it("sends somebody to the right screen when they have no key", async () => {
    getRemote.mockResolvedValue({ available: false, reason: "no-key" });
    show();
    expect(await screen.findByText(/Account → SSH keys/)).toBeTruthy();
  });

  it("says the workspace is not running rather than showing a dead command", async () => {
    // A dead command with no explanation sends somebody to debug their SSH
    // client, which is the one place the problem is not.
    getRemote.mockResolvedValue({ available: false, reason: "not-running" });
    show();

    expect(await screen.findByText("This workspace is not running")).toBeTruthy();
    expect(screen.queryByText(/^ssh -p/)).toBeNull();
  });

  it("explains what -A does, and what it costs", async () => {
    // A private clone failing inside the sandbox looks exactly like a
    // permissions problem with the repository, so this is said up front.
    show();
    expect(await screen.findByText(/forwards your SSH agent/)).toBeTruthy();
    expect(screen.getByText(/ask\s+your agent to authenticate/)).toBeTruthy();
  });

  it("says when agent forwarding is off, so a failed clone is not a mystery", async () => {
    getRemote.mockResolvedValue({
      ...AVAILABLE,
      agentForwarding: false,
      command: "ssh -p 49155 sandbox@box.example",
    });
    show();

    expect(await screen.findByText(/will need a token/)).toBeTruthy();
  });

  it("warns about the first-connect download and the egress it needs", async () => {
    show();
    expect(await screen.findByText(/update.code.visualstudio.com/)).toBeTruthy();
  });
});
