import { describe, expect, it } from "vitest";
import { extractProjectId, stripPreviewPrefix } from "./preview.js";

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
