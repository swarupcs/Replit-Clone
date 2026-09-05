// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposeState } from "@replit-clone/shared";

/** What the project's own docker-compose.yml declares. plan.md §11.3.
 *
 *  The panel exists because everything this feature refuses, it refuses
 *  silently otherwise: a service that is not on the allowlist simply never
 *  appears, and a `volumes: ["./data:/var/lib/postgresql/data"]` that was
 *  dropped looks exactly like one that worked until somebody goes looking for
 *  the files. Each test below is one of those reaching a person.
 */

const api = vi.hoisted(() => ({ getComposeApi: vi.fn() }));

vi.mock("../../../apis/projects.ts", () => api);

import { ComposeSection } from "./ComposeSection.tsx";

const STATE: ComposeState = {
  source: "docker-compose.yml",
  appService: "app",
  unsupported: [],
  error: null,
  enabled: true,
  allowedImages: ["postgres:*"],
  maxServices: 4,
  services: [
    {
      name: "db",
      image: "postgres:17-alpine",
      ports: [5432],
      envNames: ["POSTGRES_PASSWORD"],
      status: "running",
      refusal: null,
    },
  ],
};

function show(state: ComposeState | null, patch: Partial<ComposeState> = {}) {
  api.getComposeApi.mockResolvedValue(state ? { ...state, ...patch } : state);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ComposeSection projectId="p1" enabled />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("a project with no compose file", () => {
  /** Most projects. The dialog must be unchanged for them. */
  it("renders nothing at all", async () => {
    const { container } = show({
      source: null,
      appService: null,
      unsupported: [],
      error: null,
      enabled: true,
      allowedImages: [],
      maxServices: 4,
      services: [],
    });

    await vi.waitFor(() => {
      expect(api.getComposeApi).toHaveBeenCalled();
    });
    expect(container.innerHTML).toBe("");
  });
});

describe("a project with one", () => {
  it("names each service and the image behind it", async () => {
    show(STATE);

    expect(await screen.findByText("db")).toBeTruthy();
    expect(screen.getByText(/postgres:17-alpine/)).toBeTruthy();
  });

  /** The useful sentence. Nothing is published to the host, so the only way to
   *  reach one of these is by service name from the project's own container —
   *  which is what the file already told the app to do. */
  it("says where to connect once it is running", async () => {
    show(STATE);

    expect(await screen.findByText("db:5432")).toBeTruthy();
  });

  /** Named rather than listed as a service, so it does not read as one that
   *  went missing: this project's container is that service. */
  it("explains the buildable service instead of hiding it", async () => {
    show(STATE);

    expect(
      await screen.findByText(/own container is that service/),
    ).toBeTruthy();
  });
});

describe("the refusals, which are the reason this panel exists", () => {
  it("shows why a service will not be started", async () => {
    show(STATE, {
      services: [
        {
          name: "scary",
          image: "ubuntu:24.04",
          ports: [],
          envNames: [],
          status: "refused",
          refusal: 'The image "ubuntu:24.04" is not on this allowlist.',
        },
      ],
    });

    expect(await screen.findByText(/not on this allowlist/)).toBeTruthy();
  });

  it("lists a key that was read and not acted on", async () => {
    show(STATE, {
      unsupported: [
        {
          key: "services.db.volumes",
          reason: '"/" is a host path.',
        },
      ],
    });

    expect(await screen.findByText("services.db.volumes")).toBeTruthy();
    expect(screen.getByText(/One setting was not applied/)).toBeTruthy();
  });

  /** Said once at the top rather than repeated on every service: the file is
   *  fine and the deployment is the answer. */
  it("says so once when the deployment runs no services at all", async () => {
    show(STATE, { enabled: false });

    expect(
      await screen.findByText(/does not start compose services/),
    ).toBeTruthy();
  });

  it("reports a file that could not be read", async () => {
    show(STATE, { error: "docker-compose.yml is not valid YAML", services: [] });

    expect(await screen.findByText(/not valid YAML/)).toBeTruthy();
  });
});
