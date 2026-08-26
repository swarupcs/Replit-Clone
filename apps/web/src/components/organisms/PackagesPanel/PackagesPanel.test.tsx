// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PackageList } from "@replit-clone/shared";

const api = vi.hoisted(() => ({
  listPackagesApi: vi.fn(),
  addPackageApi: vi.fn(),
  removePackageApi: vi.fn(),
}));

vi.mock("../../../apis/packages.ts", () => api);

// antd's message renders through a portal and needs no assertions here.
vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

import { PackagesPanel } from "./PackagesPanel.tsx";

const NPM: PackageList = {
  ecosystem: "npm",
  manifest: "package.json",
  packages: [
    { name: "vite", version: "^6.1.0", dev: true },
    { name: "react", version: "^19.0.0" },
  ],
};

beforeEach(() => {
  api.listPackagesApi.mockResolvedValue(NPM);
  api.addPackageApi.mockResolvedValue({ output: "", packages: NPM });
  api.removePackageApi.mockResolvedValue({ output: "", packages: NPM });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel(canWrite = true) {
  return render(<PackagesPanel projectId="p1" canWrite={canWrite} />);
}

describe("PackagesPanel", () => {
  it("lists what the manifest declares, runtime dependencies first", async () => {
    renderPanel();

    // The manifest's own order is insertion order; dev goes last.
    await waitFor(() => {
      const names = screen
        .getAllByTitle(/^(react|vite)$/)
        .map((node) => node.textContent);
      expect(names).toEqual(["react", "vite"]);
    });
  });

  it("names the manifest it is reading", async () => {
    renderPanel();

    expect(await screen.findByText(/package\.json/)).toBeDefined();
  });

  it("splits a version typed alongside the name", async () => {
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.change(screen.getByPlaceholderText("package, or package@version"), {
      target: { value: "zod@3.22.0" },
    });
    fireEvent.click(screen.getByLabelText("Install"));

    await waitFor(() => {
      expect(api.addPackageApi).toHaveBeenCalledWith("p1", "zod", "3.22.0", false);
    });
  });

  it("keeps a scope attached to the name it belongs to", async () => {
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.change(screen.getByPlaceholderText("package, or package@version"), {
      target: { value: "@tanstack/react-query" },
    });
    fireEvent.click(screen.getByLabelText("Install"));

    // The leading @ is part of the name, not a version separator.
    await waitFor(() => {
      expect(api.addPackageApi).toHaveBeenCalledWith(
        "p1",
        "@tanstack/react-query",
        "",
        false,
      );
    });
  });

  it("splits a comparator the way pip is typed", async () => {
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.change(screen.getByPlaceholderText("package, or package@version"), {
      target: { value: "flask>=3" },
    });
    fireEvent.click(screen.getByLabelText("Install"));

    await waitFor(() => {
      expect(api.addPackageApi).toHaveBeenCalledWith("p1", "flask", ">=3", false);
    });
  });

  it("marks a dev install as one", async () => {
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.change(screen.getByPlaceholderText("package, or package@version"), {
      target: { value: "vitest" },
    });
    fireEvent.click(screen.getByLabelText("Install as a dev dependency"));

    await waitFor(() => {
      expect(api.addPackageApi).toHaveBeenCalledWith("p1", "vitest", "", true);
    });
  });

  it("removes by name", async () => {
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.click(screen.getByLabelText("Remove react"));

    await waitFor(() => {
      expect(api.removePackageApi).toHaveBeenCalledWith("p1", "react");
    });
  });

  it("shows the manager's own words when an install fails", async () => {
    api.addPackageApi.mockRejectedValue(new Error("404 Not Found - zzz"));
    renderPanel();
    await screen.findByTitle("react");

    fireEvent.change(screen.getByPlaceholderText("package, or package@version"), {
      target: { value: "zzz" },
    });
    fireEvent.click(screen.getByLabelText("Install"));

    expect(await screen.findByLabelText("Package manager output")).toBeDefined();
    expect(screen.getByText(/404 Not Found/)).toBeDefined();
  });

  it("gives a viewer no way to change anything", async () => {
    renderPanel(false);
    await screen.findByTitle("react");

    expect(
      screen.queryByPlaceholderText("package, or package@version"),
    ).toBeNull();
    expect(screen.queryByLabelText("Remove react")).toBeNull();
  });

  it("says so when the project has no manifest at all", async () => {
    api.listPackagesApi.mockResolvedValue({
      ecosystem: null,
      manifest: null,
      packages: [],
    });
    renderPanel();

    // Not an empty list with an add box that could only ever fail.
    expect(await screen.findByText(/no dependencies to manage/i)).toBeDefined();
    expect(
      screen.queryByPlaceholderText("package, or package@version"),
    ).toBeNull();
  });

  it("offers no dev button outside npm", async () => {
    api.listPackagesApi.mockResolvedValue({
      ecosystem: "pip",
      manifest: "requirements.txt",
      packages: [{ name: "flask", version: ">=3" }],
    });
    renderPanel();
    await screen.findByTitle("flask");

    // pip's manifest draws no dev/runtime distinction in these templates.
    expect(screen.queryByLabelText("Install as a dev dependency")).toBeNull();
  });
});
