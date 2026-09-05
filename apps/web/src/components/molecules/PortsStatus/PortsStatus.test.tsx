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

const getProjectPorts = vi.hoisted(() => vi.fn());
vi.mock("../../../apis/projects.ts", () => ({ getProjectPorts }));

import { PortsStatus } from "./PortsStatus.tsx";

const PROJECT = "p1";

/** The response as the server sends it in development: publishing on loopback,
 *  so every offered port has an address. */
function ports(over: Record<string, unknown> = {}) {
  return {
    devPort: 3000,
    ports: [3000, 5173],
    hostPorts: { 3000: "127.0.0.1:32774", 5173: "127.0.0.1:32775" },
    ...over,
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <PortsStatus projectId={PROJECT} />
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

describe("the published-ports indicator", () => {
  it("shows where the dev port is reachable on this machine", async () => {
    show();

    expect(await screen.findByText("127.0.0.1:32774")).toBeDefined();
  });

  /** The dev port is what somebody is nearly always after, and it is not
   *  necessarily the first one the server lists. */
  it("leads with the dev port rather than the lowest one", async () => {
    getProjectPorts.mockResolvedValue(
      ports({ devPort: 5173, ports: [3000, 5173] }),
    );
    show();

    expect(await screen.findByText("127.0.0.1:32775")).toBeDefined();
  });

  it("says how many others there are", async () => {
    show();

    expect(await screen.findByText("+1")).toBeDefined();
  });

  it("does not count a lone port as having others", async () => {
    getProjectPorts.mockResolvedValue(
      ports({ ports: [3000], hostPorts: { 3000: "127.0.0.1:32774" } }),
    );
    show();

    await screen.findByText("127.0.0.1:32774");
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("copies the address as a URL", async () => {
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

  /** The point of the whole design. In a deployment the server publishes
   *  nothing to the host and sends no addresses, so this vanishes — at exactly
   *  the moment the habit it teaches would stop working. No build flag decides
   *  that; the absence of the data does. */
  it("is absent when the server publishes nothing", async () => {
    getProjectPorts.mockResolvedValue(ports({ hostPorts: {} }));
    const { container } = show();

    await waitFor(() => {
      expect(getProjectPorts).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });

  /** A port that is offered but not bound has no address to give, and showing
   *  the port alone would send somebody to a number nothing is listening on. */
  it("shows only the ports that have an address", async () => {
    getProjectPorts.mockResolvedValue(
      ports({ hostPorts: { 5173: "127.0.0.1:32775" } }),
    );
    show();

    expect(await screen.findByText("127.0.0.1:32775")).toBeDefined();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});
