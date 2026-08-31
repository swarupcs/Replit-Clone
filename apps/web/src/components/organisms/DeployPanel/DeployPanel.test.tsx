// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Deployment, DeploymentState } from "@replit-clone/shared";

const api = vi.hoisted(() => ({
  getDeploymentApi: vi.fn(),
  deployApi: vi.fn(),
  undeployApi: vi.fn(),
}));

vi.mock("../../../apis/deployments.ts", () => api);

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

import { DeployPanel } from "./DeployPanel.tsx";

const LIVE: Deployment = {
  status: "live",
  kind: "static",
  port: null,
  subdomain: "quiet-fern-84f1",
  url: "http://quiet-fern-84f1.localhost:3102",
  buildCommand: "npm install && npm run build",
  outputDir: "dist",
  sizeBytes: 1_572_864,
  log: "vite v6.1.0 building for production...",
  error: null,
  deployedAt: new Date().toISOString(),
  customDomain: null,
};

const DEPLOYABLE: DeploymentState = {
  target: {
    deployable: true,
    kind: "static",
    port: null,
    buildCommand: "npm install && npm run build",
    outputDir: "dist",
  },
  deployment: null,
};

beforeEach(() => {
  api.getDeploymentApi.mockResolvedValue(DEPLOYABLE);
  api.deployApi.mockResolvedValue(LIVE);
  api.undeployApi.mockResolvedValue(DEPLOYABLE);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(state: DeploymentState, isOwner = true) {
  api.getDeploymentApi.mockResolvedValue(state);
  return render(<DeployPanel projectId="p1" isOwner={isOwner} />);
}

describe("a project that has never been published", () => {
  it("offers to publish it, and says what that means", async () => {
    show(DEPLOYABLE);

    expect(
      await screen.findByRole("button", { name: "Deploy" }),
    ).toBeDefined();
    expect(screen.getByText(/no account/i)).toBeDefined();
  });

  it("shows the command that will run, so a failure has context", async () => {
    show(DEPLOYABLE);

    expect(
      await screen.findByText("npm install && npm run build"),
    ).toBeDefined();
    expect(screen.getByText("→ dist")).toBeDefined();
  });

  it("offers nothing to take offline, because nothing is up", async () => {
    show(DEPLOYABLE);

    await screen.findByRole("button", { name: "Deploy" });
    expect(
      screen.queryByRole("button", { name: "Take offline" }),
    ).toBeNull();
  });
});

describe("a live deployment", () => {
  const state: DeploymentState = { ...DEPLOYABLE, deployment: LIVE };

  it("puts the address first, as a link that opens it", async () => {
    show(state);

    const link = await screen.findByRole("link", {
      name: "quiet-fern-84f1.localhost:3102",
    });
    expect(link.getAttribute("href")).toBe(LIVE.url);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("opens the site without handing it the editor's window", async () => {
    // A published site is untrusted code. Without `noopener` the new tab keeps
    // a handle on window.opener and can navigate the editor away.
    show(state);

    const link = await screen.findByRole("link", {
      name: "quiet-fern-84f1.localhost:3102",
    });
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("says when it went up and how large it is", async () => {
    show(state);
    expect(await screen.findByText(/Published just now/)).toBeDefined();
    expect(screen.getByText(/1\.5 MB/)).toBeDefined();
  });

  it("offers a redeploy rather than a first deploy", async () => {
    show(state);
    expect(
      await screen.findByRole("button", { name: /Redeploy/ }),
    ).toBeDefined();
  });

  it("takes it offline when asked", async () => {
    show(state);

    fireEvent.click(await screen.findByRole("button", { name: "Take offline" }));

    await waitFor(() => {
      expect(api.undeployApi).toHaveBeenCalledWith("p1");
    });
  });
});

describe("a deployment that failed", () => {
  const failed: DeploymentState = {
    ...DEPLOYABLE,
    deployment: {
      ...LIVE,
      status: "failed",
      url: null,
      deployedAt: null,
      error: "Could not resolve './missing' from src/main.jsx",
      log: "error during build:\nCould not resolve './missing'",
    },
  };

  it("shows the reason where it happened, not only as a toast", async () => {
    show(failed);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not resolve './missing'");
  });

  it("shows the build's own output", async () => {
    show(failed);
    expect(
      (await screen.findByLabelText("Build output")).textContent,
    ).toContain("error during build");
  });

  it("does not offer a link to a site that is not there", async () => {
    show(failed);
    await screen.findByRole("alert");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("a project that cannot be published statically", () => {
  it("explains why instead of offering a button that would fail", async () => {
    show({
      target: {
        deployable: false,
        kind: "static",
        port: null,
        reason: "This project serves requests from a running process.",
        buildCommand: "",
        outputDir: "",
      },
      deployment: null,
    });

    expect(
      await screen.findByText(/serves requests from a running process/),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Deploy" }),
    ).toBeNull();
  });
});

describe("somebody who is not the owner", () => {
  it("sees where the site is but cannot publish it", async () => {
    // Publishing puts a project in front of the entire internet. Write access
    // to a file is a different decision from that one.
    show({ ...DEPLOYABLE, deployment: LIVE }, false);

    expect(
      await screen.findByRole("link", {
        name: "quiet-fern-84f1.localhost:3102",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Redeploy/ }),
    ).toBeNull();
    expect(screen.getByText(/Only the project's owner/)).toBeDefined();
  });
});

describe("deploying", () => {
  it("re-reads the row when a deploy fails, so the log arrives", async () => {
    // The failure is recorded on the row along with the build output. A toast
    // alone would leave the user with no way to see what the build said.
    api.deployApi.mockRejectedValue(new Error("The build command failed"));
    show(DEPLOYABLE);

    fireEvent.click(await screen.findByRole("button", { name: "Deploy" }));

    await waitFor(() => {
      expect(api.getDeploymentApi).toHaveBeenCalledTimes(2);
    });
  });
});
