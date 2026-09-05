import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique } },
}));
vi.mock("../service/projectService.js", () => ({ assertProjectAccess: vi.fn() }));
vi.mock("../containers/containerManager.js", () => ({
  ensureContainer: vi.fn(),
  getPreviewTarget: vi.fn(),
}));
vi.mock("../service/tokenService.js", () => ({
  PREVIEW_COOKIE_NAME: "preview_token",
  verifyPreviewToken: vi.fn(),
}));
vi.mock("../service/hmrSockets.js", () => ({
  noteHmrClosed: vi.fn(),
  noteHmrOpen: vi.fn(),
}));

const { extractProjectId, stripPreviewPrefix, expectsPreviewBase } = await import(
  "./preview.js"
);

beforeEach(() => {
  findUnique.mockReset();
});

const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("extractProjectId", () => {
  it("finds the id in a preview path", () => {
    expect(extractProjectId(`/preview/${PROJECT}/`)).toBe(PROJECT);
  });

  it("finds it in an HMR upgrade path", () => {
    expect(extractProjectId(`/preview/${PROJECT}/@vite-hmr`)).toBe(PROJECT);
  });

  it("finds it in a full url", () => {
    expect(extractProjectId(`https://api.example.com/preview/${PROJECT}/x`)).toBe(
      PROJECT,
    );
  });

  it("returns undefined when there is no preview segment", () => {
    expect(extractProjectId("/api/v1/projects")).toBeUndefined();
    expect(extractProjectId(`/other/${PROJECT}/`)).toBeUndefined();
  });
});

describe("stripPreviewPrefix", () => {
  it.each([
    [`/preview/${PROJECT}/@vite-hmr`, "", "/@vite-hmr"],
    [`/preview/${PROJECT}/`, "", "/"],
    // The bare prefix with no trailing slash must still become a root path,
    // not an empty one, or the proxied request has no path at all.
    [`/preview/${PROJECT}`, "", "/"],
    [`/preview/${PROJECT}/ws`, "?token=abc", "/ws?token=abc"],
    [`/preview/${PROJECT}/a/b/c.js`, "?v=1", "/a/b/c.js?v=1"],
  ])("rewrites %s%s to %s", (pathname, search, expected) => {
    expect(stripPreviewPrefix(pathname, search, PROJECT)).toBe(expected);
  });

  it("always yields a path the proxy can request", () => {
    for (const pathname of [
      `/preview/${PROJECT}`,
      `/preview/${PROJECT}/`,
      `/preview/${PROJECT}/deep/path`,
    ]) {
      expect(stripPreviewPrefix(pathname, "", PROJECT).startsWith("/")).toBe(true);
    }
  });
});

describe("whose answer decides that a project serves under the prefix", () => {
  /** The template's answer is right for a starter and for a scaffold the
   *  preview contract has adapted -- both were built to match it. It is a
   *  guess for anything else, and plan.md 2.43 is the story of that guess
   *  being wrong for every project built with "Latest".
   *
   *  A project overrides it by saying so on its own row. Null is not "false":
   *  it means "ask the template", which is what almost every project says. */
  it("uses the template when the project has no opinion", async () => {
    findUnique.mockResolvedValue({ template: "react-vite", expectsPreviewBase: null });

    await expect(expectsPreviewBase(PROJECT)).resolves.toBe(true);
  });

  it("lets the project overrule its template", async () => {
    findUnique.mockResolvedValue({ template: "nextjs", expectsPreviewBase: false });

    await expect(expectsPreviewBase(PROJECT)).resolves.toBe(false);
  });

  /** Both directions, so the override is a real override rather than a way of
   *  only ever saying no. */
  it("overrules in the other direction too", async () => {
    findUnique.mockResolvedValue({
      template: "node-express",
      expectsPreviewBase: true,
    });

    await expect(expectsPreviewBase(PROJECT)).resolves.toBe(true);
  });

  /** A project that is gone cannot be previewed, and forwarding the prefix to
   *  nothing is the wrong default to pick on the way out. */
  it("says no for a project that does not exist", async () => {
    findUnique.mockResolvedValue(null);

    await expect(expectsPreviewBase(PROJECT)).resolves.toBe(false);
  });
});
