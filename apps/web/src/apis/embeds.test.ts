// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { embedSnippet, embedUrl } from "./embeds.ts";

/** The snippet is pasted into somebody's HTML by hand, so the two things that
 *  matter are that the URL is right and that a project name cannot break out of
 *  the attribute it lands in. */

describe("embedUrl", () => {
  it("hangs off the page's own origin", () => {
    // Whatever address the owner is looking at this on is the address their
    // readers will reach it on.
    expect(embedUrl("tok")).toBe(`${window.location.origin}/embed/tok`);
  });

  it("carries only the options that were given", () => {
    const url = new URL(embedUrl("tok", { view: "code" }));

    expect(url.searchParams.get("view")).toBe("code");
    expect(url.searchParams.has("file")).toBe(false);
    expect(url.searchParams.has("theme")).toBe(false);
  });

  it("escapes an option's value rather than concatenating it", () => {
    const url = new URL(embedUrl("tok", { file: "src/a b&c.tsx" }));

    expect(url.searchParams.get("file")).toBe("src/a b&c.tsx");
  });
});

describe("embedSnippet", () => {
  it("puts the URL in the src and the name in the title", () => {
    const snippet = embedSnippet("https://example.test/embed/tok", "demo");

    expect(snippet).toContain('src="https://example.test/embed/tok"');
    expect(snippet).toContain('title="demo"');
  });

  it("does not let a project name close the attribute", () => {
    // Project names are user input and this string is pasted into a page as
    // markup, so a quote in one would otherwise be an injection into the
    // author's own site.
    const snippet = embedSnippet(
      "https://example.test/embed/tok",
      '" onload="alert(1)',
    );

    expect(snippet).not.toContain('onload="alert(1)"');
    expect(snippet).toContain("&quot;");
  });
});
