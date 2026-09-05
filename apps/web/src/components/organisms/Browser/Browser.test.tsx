// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getProjectPorts = vi.hoisted(() => vi.fn());
vi.mock("../../../apis/projects.ts", () => ({ getProjectPorts }));

import { Browser } from "./Browser.tsx";

const PROJECT = "p1";

/** The response as the server sends it in development: publishing on loopback,
 *  so every offered port has an address. */
function ports(over: Record<string, unknown> = {}) {
  return {
    devPort: 3000,
    ports: [3000, 5173, 8080],
    hostPorts: {
      3000: "127.0.0.1:32774",
      5173: "127.0.0.1:32775",
      8080: "127.0.0.1:32776",
    },
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Browser projectId={PROJECT} />
    </QueryClientProvider>,
  );
}

const writeText = vi.hoisted(() => vi.fn());

beforeEach(() => {
  vi.clearAllMocks();
  getProjectPorts.mockResolvedValue(ports());
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(cleanup);

describe("the host address", () => {
  it("shows where the selected port is published", async () => {
    show();

    expect(await screen.findByText("127.0.0.1:32774")).toBeDefined();
  });

  it("follows the port selector", async () => {
    show();
    await screen.findByText("127.0.0.1:32774");

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByTitle(":8080"));

    expect(await screen.findByText("127.0.0.1:32776")).toBeDefined();
  });

  it("copies it as a URL", async () => {
    show();
    fireEvent.click(await screen.findByText("127.0.0.1:32774"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:32774");
    });
    expect(await screen.findByText("copied")).toBeDefined();
  });

  /** A LAN address is not a secure context, so the clipboard genuinely throws
   *  there. The address stays on screen to be read off rather than the click
   *  appearing to have done something it did not. */
  it("survives a clipboard that refuses", async () => {
    writeText.mockRejectedValue(new Error("not allowed"));
    show();

    fireEvent.click(await screen.findByText("127.0.0.1:32774"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(screen.queryByText("copied")).toBeNull();
    expect(screen.getByText("127.0.0.1:32774")).toBeDefined();
  });

  /** The point of the whole design: in a deployment the server publishes
   *  nothing to the host, sends no addresses, and this control does not exist.
   *  No build flag decides that — the absence of the data does. */
  it("is absent when the server publishes nothing", async () => {
    getProjectPorts.mockResolvedValue(ports({ hostPorts: {} }));
    show();

    // The port selector still renders, so the toolbar has loaded.
    expect(await screen.findByRole("combobox")).toBeDefined();
    expect(screen.queryByText(/127\.0\.0\.1:/)).toBeNull();
  });

  it("is absent for a port with no address of its own", async () => {
    getProjectPorts.mockResolvedValue(
      ports({ hostPorts: { 5173: "127.0.0.1:32775" } }),
    );
    show();

    expect(await screen.findByRole("combobox")).toBeDefined();
    expect(screen.queryByText(/127\.0\.0\.1:/)).toBeNull();
  });
});
