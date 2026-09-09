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
import type { AccountSecrets } from "@replit-clone/shared";

const getSecrets = vi.fn();
const setSecrets = vi.fn();

vi.mock("../../../apis/projects.ts", () => ({
  getAccountSecretsApi: () => getSecrets() as unknown,
  setAccountSecretsApi: (vars: Record<string, string>) =>
    setSecrets(vars) as unknown,
}));

import { Secrets } from "./Secrets.tsx";

function state(over: Partial<AccountSecrets> = {}): AccountSecrets {
  return {
    vars: { ANTHROPIC_API_KEY: "sk-live" },
    encryptedAtRest: true,
    sharedProjects: 0,
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Secrets />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  // Without this each render stacks on the last one and every query matches
  // twice, which reads as a component bug and is not one.
  cleanup();
});

beforeEach(() => {
  getSecrets.mockReset().mockResolvedValue(state());
  setSecrets.mockReset().mockImplementation((vars: Record<string, string>) =>
    Promise.resolve(state({ vars })),
  );
});

describe("the account secrets panel", () => {
  it("lists what is stored", async () => {
    show();
    await waitFor(() => {
      expect(screen.getByDisplayValue("ANTHROPIC_API_KEY")).toBeTruthy();
    });
  });

  it("says a project's own value wins", async () => {
    show();
    // The merge order is the only new decision in §13.8, and somebody reading
    // this panel has to be able to predict what their container gets.
    expect(
      await screen.findByText(/A project that sets the same name uses its own value/),
    ).toBeTruthy();
  });

  it("sends the whole set on save, so a removal is a removal", async () => {
    show();
    await waitFor(() => {
      expect(screen.getByDisplayValue("ANTHROPIC_API_KEY")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Remove ANTHROPIC_API_KEY"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // A patch has no way to express "delete this one".
    await waitFor(() => {
      expect(setSecrets).toHaveBeenCalledWith({});
    });
  });

  it("saves an added variable", async () => {
    getSecrets.mockResolvedValue(state({ vars: {} }));
    show();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "NPM_TOKEN" },
    });
    fireEvent.change(screen.getByLabelText("Value for NPM_TOKEN"), {
      target: { value: "npm_abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setSecrets).toHaveBeenCalledWith({ NPM_TOKEN: "npm_abc" });
    });
  });

  it("cannot be saved until something changes", async () => {
    show();
    await waitFor(() => {
      expect(screen.getByDisplayValue("ANTHROPIC_API_KEY")).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("says so when the server cannot encrypt them", async () => {
    getSecrets.mockResolvedValue(state({ encryptedAtRest: false }));
    show();

    // A panel that looks identical either way is a panel that lies on one of
    // the two servers.
    expect(await screen.findByText("Not encrypted at rest")).toBeTruthy();
  });

  it("names how many projects somebody else can reach", async () => {
    getSecrets.mockResolvedValue(state({ sharedProjects: 3 }));
    show();

    expect(await screen.findByText(/3 of your projects are shared/)).toBeTruthy();
  });

  it("says nothing about sharing when nothing is shared", async () => {
    show();
    await waitFor(() => {
      expect(screen.getByDisplayValue("ANTHROPIC_API_KEY")).toBeTruthy();
    });

    // A standing warning about a thing that does not apply is one people learn
    // to skip, and this has to still be readable on the day it matters.
    expect(screen.queryByText(/of your projects/)).toBeNull();
  });
});
