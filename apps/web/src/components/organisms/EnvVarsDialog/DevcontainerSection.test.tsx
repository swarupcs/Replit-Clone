// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevcontainerState } from "@replit-clone/shared";

const api = vi.hoisted(() => ({ getDevcontainerApi: vi.fn() }));

vi.mock("../../../apis/projects.ts", () => api);

import { DevcontainerSection } from "./DevcontainerSection.tsx";

const CONFIG: DevcontainerState = {
  config: {
    source: ".devcontainer/devcontainer.json",
    requestedImage: "sandbox-node:latest",
    forwardPorts: [3000, 8080],
    containerEnvNames: ["API_URL"],
    postCreateCommand: ["npm ci"],
    postStartCommand: [],
    workspaceFolder: null,
    unsupported: [],
  },
  imageInUse: "sandbox-node:latest",
  error: null,
  refusedMounts: [],
  mountsAllowed: false,
  lifecycleLog: "",
  running: false,
  allowedImages: ["sandbox-node:latest"],
};

function show(state: DevcontainerState | null) {
  api.getDevcontainerApi.mockResolvedValue(state);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <DevcontainerSection projectId="p1" enabled />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.getDevcontainerApi.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("a project with a devcontainer", () => {
  it("names the file it read", async () => {
    show(CONFIG);
    expect(
      await screen.findByText(".devcontainer/devcontainer.json"),
    ).toBeDefined();
  });

  it("shows the image, the ports and the setup command", async () => {
    show(CONFIG);

    expect(await screen.findByText("sandbox-node:latest")).toBeDefined();
    expect(screen.getByText("3000, 8080")).toBeDefined();
    expect(screen.getByText("npm ci")).toBeDefined();
  });

  it("lists variable NAMES without their values", async () => {
    // The server never sends the values: they are the user's own, and they are
    // also the shape a secret takes.
    show(CONFIG);

    expect(await screen.findByText("API_URL")).toBeDefined();
  });

  it("says a restart is needed when the running image is not the one asked for", async () => {
    // A container built before the config changed keeps the old image until it
    // is rebuilt, and that is the confusing case this exists to name.
    show({
      ...CONFIG,
      imageInUse: "sandbox-python:latest",
      config: { ...CONFIG.config!, requestedImage: "sandbox-node:latest" },
    });

    expect(await screen.findByText(/restart to apply/i)).toBeDefined();
  });

  it("stays quiet about a restart when the images agree", async () => {
    show(CONFIG);
    await screen.findByText("sandbox-node:latest");

    expect(screen.queryByText(/restart to apply/i)).toBeNull();
  });
});

describe("a config that was not fully applied", () => {
  it("lists each refused setting with its reason", async () => {
    // A half-applied config is worse than a rejected one, because the user
    // cannot tell which half ran.
    show({
      ...CONFIG,
      config: {
        ...CONFIG.config!,
        unsupported: [
          { key: "features", reason: "Use postCreateCommand instead." },
          { key: "mounts", reason: "Extra mounts are not supported." },
        ],
      },
    });

    expect(await screen.findByText("2 settings were not applied")).toBeDefined();
    expect(screen.getByText("features")).toBeDefined();
    expect(screen.getByText(/Use postCreateCommand instead/)).toBeDefined();
  });

  it("counts one refusal in the singular", async () => {
    show({
      ...CONFIG,
      config: {
        ...CONFIG.config!,
        unsupported: [{ key: "mounts", reason: "Not supported." }],
      },
    });

    expect(await screen.findByText("One setting was not applied")).toBeDefined();
  });
});

describe("a config that could not be honoured", () => {
  it("shows the reason as an alert", async () => {
    show({
      ...CONFIG,
      config: null,
      error: 'The image "postgres:17" is not permitted on this server.',
      imageInUse: "sandbox-node:latest",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not permitted");
  });
});

describe("the setup output", () => {
  it("is shown when there is any", async () => {
    show({ ...CONFIG, lifecycleLog: "$ npm ci\nadded 210 packages" });

    expect(
      (await screen.findByLabelText("Dev container setup output")).textContent,
    ).toContain("added 210 packages");
  });

  it("says when the commands are still going", async () => {
    show({ ...CONFIG, running: true });
    expect(await screen.findByText("running")).toBeDefined();
  });
});

describe("a project without a devcontainer", () => {
  it("renders nothing at all", async () => {
    // The dialog must be unchanged for the projects that do not have one.
    const { container } = show({
      config: null,
      imageInUse: "sandbox-node:latest",
      error: null,
      refusedMounts: [],
      mountsAllowed: false,
      lifecycleLog: "",
      running: false,
      allowedImages: [],
    });

    await vi.waitFor(() => {
      expect(api.getDevcontainerApi).toHaveBeenCalled();
    });
    expect(container.textContent).toBe("");
  });
});


/** A mount that was read, understood, and then not allowed.
 *
 *  Kept apart from the unsupported-keys block on purpose: an unsupported key
 *  was never read, and a refused mount was — which means only the second can
 *  be fixed by changing a setting rather than the file.
 */
describe("refused mounts", () => {
  it("says nothing when none were refused", async () => {
    show(CONFIG);

    await screen.findByText(".devcontainer/devcontainer.json");
    expect(screen.queryByText(/mount.*refused/i)).toBeNull();
  });

  it("names each one and why", async () => {
    show({
      ...CONFIG,
      refusedMounts: [
        {
          source: "/etc",
          reason: "That is outside the directories this deployment may mount.",
        },
      ],
      mountsAllowed: true,
    });

    expect(await screen.findByText("One mount was refused")).toBeTruthy();
    expect(screen.getByText("/etc")).toBeTruthy();
  });

  /** A refusal that says only "no" leaves somebody editing the file forever.
   *  When the deployment permits no mounts at all, that is the thing to say. */
  it("says when the deployment mounts nothing at all", async () => {
    show({
      ...CONFIG,
      refusedMounts: [{ source: "/data", reason: "Not permitted." }],
      mountsAllowed: false,
    });

    expect(
      await screen.findByText(/mounts nothing but the project itself/),
    ).toBeTruthy();
  });
});
