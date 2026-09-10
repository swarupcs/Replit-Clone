// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { BrowserPreviewPlan } from "@replit-clone/shared";

const getPlan = vi.fn();
vi.mock("../../../apis/projects.ts", () => ({
  getBrowserPreviewApi: () => getPlan() as unknown,
}));

const bundleMock = vi.fn();
vi.mock("../../../lib/browserBundler.ts", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/browserBundler.ts")>(
    "../../../lib/browserBundler.ts",
  );
  return { ...actual, bundle: () => bundleMock() as unknown };
});

import { BrowserPreview } from "./BrowserPreview.tsx";

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function plan(over: Partial<BrowserPreviewPlan> = {}): BrowserPreviewPlan {
  return {
    supported: true,
    entry: "src/main.tsx",
    files: { "src/main.tsx": "" },
    dependencies: [],
    ...over,
  };
}

beforeEach(() => {
  getPlan.mockReset().mockResolvedValue(plan());
  bundleMock.mockReset().mockResolvedValue({ code: "BUNDLED", warnings: [] });
});

afterEach(() => {
  cleanup();
});

describe("a preview with no container", () => {
  it("renders the bundle in a sandboxed iframe", async () => {
    render(<BrowserPreview projectId={PROJECT} />);

    const frame = await screen.findByTitle("Preview");
    expect(frame.getAttribute("srcdoc")).toContain("BUNDLED");
  });

  it("does not give the iframe the same origin", async () => {
    // `allow-scripts` with `allow-same-origin` is no sandbox at all: the
    // project's code could reach this app's cookies, storage and DOM.
    render(<BrowserPreview projectId={PROJECT} />);

    const sandbox = (await screen.findByTitle("Preview")).getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("says what a server project is, rather than failing", async () => {
    // A reader who sees "failed" concludes the project is broken.
    getPlan.mockResolvedValue({
      supported: false,
      reason: "needs-a-server",
      message: "This project runs a server, so it needs a container.",
    });

    render(<BrowserPreview projectId={PROJECT} />);
    expect(await screen.findByText("Not a browser preview")).toBeTruthy();
    expect(screen.queryByTitle("Preview")).toBeNull();
  });

  it("shows a build failure as a build failure", async () => {
    bundleMock.mockRejectedValue(new Error("Unexpected token }"));
    render(<BrowserPreview projectId={PROJECT} />);

    expect(await screen.findByText("The build failed")).toBeTruthy();
    expect(screen.getByText(/Unexpected token/)).toBeTruthy();
  });

  it("names the CDN when that is what could not be reached", async () => {
    bundleMock.mockRejectedValue(new Error("Failed to fetch"));
    render(<BrowserPreview projectId={PROJECT} />);

    expect(await screen.findByText(/esm\.sh/)).toBeTruthy();
  });

  it("says the host is not running anything", async () => {
    // The point of the row, and the thing that distinguishes this pane from
    // the one beside it.
    render(<BrowserPreview projectId={PROJECT} />);
    expect(
      await screen.findByText(/no container is running/i),
    ).toBeTruthy();
  });

  it("rebuilds on demand", async () => {
    render(<BrowserPreview projectId={PROJECT} />);
    await screen.findByTitle("Preview");

    screen.getByLabelText("Rebuild the preview").click();
    await waitFor(() => {
      expect(bundleMock).toHaveBeenCalledTimes(2);
    });
  });
});
