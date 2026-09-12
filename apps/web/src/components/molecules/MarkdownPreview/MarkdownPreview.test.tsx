// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

afterEach(() => {
  cleanup();
});

describe("previewing a markdown file", () => {
  it("renders headings and text rather than showing the source", () => {
    render(<MarkdownPreview source={"# Title\n\nSome words."} />);

    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Some words.")).toBeTruthy();
    // The hashes are markup, not content.
    expect(screen.queryByText("# Title")).toBeNull();
  });

  it("renders a list", () => {
    render(<MarkdownPreview source={"- one\n- two"} />);
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
  });

  it("refuses a javascript: link, through the parser's own guard", () => {
    // The reason this reuses §2.42's renderer rather than adding `marked` plus
    // `dompurify`: `safeHref` already decides this, and a second markdown path
    // would be a second place to get it right.
    render(<MarkdownPreview source={"[click](javascript:alert(1))"} />);

    // `safeHref` returns null for this, and the renderer draws the text
    // without an anchor at all -- so there is no link rather than a defanged
    // one, which is the stronger outcome.
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector('[href*="javascript:"]')).toBeNull();
  });

  it("renders an empty file without falling over", () => {
    render(<MarkdownPreview source="" />);
    expect(document.querySelector(".rc-markdown-preview")).toBeTruthy();
  });
});
