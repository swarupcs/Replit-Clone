// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EmbedPayload } from "@replit-clone/shared";

const api = vi.hoisted(() => ({
  getEmbedApi: vi.fn(),
  getEmbedFileApi: vi.fn(),
}));

vi.mock("../apis/embeds.ts", () => api);

// Monaco cannot run in jsdom -- it needs workers, layout and a real canvas.
// What this page does around it is the part worth testing.
vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="editor">{value}</div>
  ),
}));
vi.mock("../config/monacoSetup.ts", () => ({}));

import { EmbedPage } from "./EmbedPage.tsx";

const PAYLOAD: EmbedPayload = {
  projectName: "demo",
  template: "react-vite",
  view: "split",
  activeFile: "src/App.tsx",
  files: [
    { relPath: "src/App.tsx", size: 100 },
    { relPath: "README.md", size: 20 },
  ],
  previewUrl: "http://quiet-fern.localhost:3102",
  projectUrl: "http://localhost:5273/project/p1",
};

function show(payload: EmbedPayload | Error, search = "") {
  if (payload instanceof Error) api.getEmbedApi.mockRejectedValue(payload);
  else api.getEmbedApi.mockResolvedValue(payload);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/embed/abc${search}`]}>
        <Routes>
          <Route path="/embed/:token" element={<EmbedPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.getEmbedApi.mockReset();
  api.getEmbedFileApi.mockReset();
  api.getEmbedFileApi.mockResolvedValue({
    relPath: "src/App.tsx",
    contents: "export const App = () => null;",
    truncated: false,
  });

  // jsdom has no matchMedia unless a test installs one, and the theme hook
  // reads it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  // jsdom reports 1024, which is above the split threshold. Set it explicitly
  // so the width-dependent cases are not resting on a default.
  window.innerWidth = 1200;
});

afterEach(() => {
  cleanup();
});

describe("an embed that loads", () => {
  it("names the project and lists its files", async () => {
    show(PAYLOAD);

    expect(await screen.findByText("demo")).toBeDefined();
    expect(screen.getByText("src/App.tsx")).toBeDefined();
    expect(screen.getByText("README.md")).toBeDefined();
  });

  it("opens the file the owner chose", async () => {
    show(PAYLOAD);

    await screen.findByText("demo");
    expect(api.getEmbedFileApi).toHaveBeenCalledWith("abc", "src/App.tsx");
  });

  it("opens a different one when the URL asks for it", async () => {
    // So one token can appear twice in an article showing different files.
    show(PAYLOAD, "?file=README.md");

    await screen.findByText("demo");
    expect(api.getEmbedFileApi).toHaveBeenCalledWith("abc", "README.md");
  });

  it("ignores a URL file the embed does not serve", async () => {
    // Including, specifically, one the secret rules hid.
    show(PAYLOAD, "?file=.env");

    await screen.findByText("demo");
    expect(api.getEmbedFileApi).toHaveBeenCalledWith("abc", "src/App.tsx");
  });

  it("fetches a file when the reader clicks it", async () => {
    show(PAYLOAD);

    fireEvent.click(await screen.findByText("README.md"));

    expect(api.getEmbedFileApi).toHaveBeenCalledWith("abc", "README.md");
  });

  it("frames the published site", async () => {
    show(PAYLOAD);

    await screen.findByText("demo");
    const frame = screen.getByTitle("demo preview");
    expect(frame.getAttribute("src")).toBe(PAYLOAD.previewUrl);
    // Not ours, and not permitted to navigate the page that frames it.
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("opens the project in a new tab, never inside the frame", async () => {
    show(PAYLOAD);

    const link = await screen.findByText("Open project");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

describe("what fits", () => {
  it("drops the preview half when the project is not deployed", async () => {
    show({ ...PAYLOAD, previewUrl: null });

    await screen.findByText("demo");
    expect(screen.queryByTitle("demo preview")).toBeNull();
    // And offers no tabs, because there is only one thing to show.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows code alone in a narrow frame, even when asked for both", async () => {
    // An article's column is often 400px wide. Two panes in it is neither.
    window.innerWidth = 380;
    show(PAYLOAD);

    await screen.findByText("demo");
    expect(screen.queryByTitle("demo preview")).toBeNull();
  });

  it("honours a preview-only embed", async () => {
    show({ ...PAYLOAD, view: "preview" });

    await screen.findByTitle("demo preview");
    expect(screen.queryByLabelText("Files")).toBeNull();
  });

  it("lets the reader switch to the preview", async () => {
    show({ ...PAYLOAD, view: "code" });

    await screen.findByText("demo");
    expect(screen.queryByTitle("demo preview")).toBeNull();

    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByTitle("demo preview")).toBeDefined();
  });
});

describe("an embed that is gone", () => {
  it("says so without saying which kind of gone", async () => {
    // A revoked embed, a deleted project and a mistyped token are one answer.
    show(new Error("Request failed with status code 404"));

    expect(
      await screen.findByText("This embed is no longer available."),
    ).toBeDefined();
  });
});

describe("a file too long to embed", () => {
  it("says the reader is seeing part of it", async () => {
    api.getEmbedFileApi.mockResolvedValue({
      relPath: "src/App.tsx",
      contents: "x".repeat(100),
      truncated: true,
    });
    show(PAYLOAD);

    expect(await screen.findByRole("status")).toBeDefined();
  });
});
