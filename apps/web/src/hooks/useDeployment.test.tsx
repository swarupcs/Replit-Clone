// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDeployment } from "./useDeployment.ts";

/** What this deployment has routes for.
 *
 *  The reason this is worth a test of its own is the DEFAULT. Every consumer
 *  hides a control when a capability is false, so a hook that returned false
 *  while its query was in flight would blink the Share button and the Explore
 *  section out of every ordinary deployment on every page load — and would hide
 *  them permanently on any deployment where the request failed.
 *
 *  Defaulting on is therefore not laziness about loading states. It is the only
 *  safe direction: briefly showing a control that works beats briefly hiding
 *  one that does.
 */

const getAuthProvidersApi = vi.hoisted(() => vi.fn());
vi.mock("../apis/auth.ts", () => ({ getAuthProvidersApi }));

function Probe() {
  const { capabilities, singleUser } = useDeployment();

  return (
    <ul>
      <li>sharing:{String(capabilities.sharing)}</li>
      <li>gallery:{String(capabilities.gallery)}</li>
      <li>moderation:{String(capabilities.moderation)}</li>
      <li>single:{String(singleUser)}</li>
    </ul>
  );
}

function renderProbe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("before the answer arrives", () => {
  it("assumes an ordinary deployment", async () => {
    // Never resolves, so this is the in-flight state and nothing else.
    getAuthProvidersApi.mockReturnValue(new Promise(() => undefined));

    renderProbe();

    await waitFor(
      () => {
        expect(screen.getByText("sharing:true")).toBeTruthy();
      },
      { timeout: 20000 },
    );
    expect(screen.getByText("gallery:true")).toBeTruthy();
  });
});

describe("when the request fails", () => {
  it("still assumes an ordinary deployment", async () => {
    getAuthProvidersApi.mockRejectedValue(new Error("offline"));

    renderProbe();

    // The direction that matters. Defaulting the other way would hide Share
    // and Explore on every deployment the moment this endpoint hiccuped, and
    // it would look like the features had been removed.
    await waitFor(() => {
      expect(screen.getByText("sharing:true")).toBeTruthy();
    });
    expect(screen.getByText("moderation:true")).toBeTruthy();
  });
});

describe("when the deployment has one account", () => {
  it("reports what is switched off", async () => {
    getAuthProvidersApi.mockResolvedValue({
      github: false,
      singleUser: true,
      capabilities: {
        sharing: false,
        moderation: false,
        operatorConsole: false,
        gallery: false,
        plans: false,
      },
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByText("sharing:false")).toBeTruthy();
    });
    expect(screen.getByText("gallery:false")).toBeTruthy();
    expect(screen.getByText("moderation:false")).toBeTruthy();
    expect(screen.getByText("single:true")).toBeTruthy();
  });
});
