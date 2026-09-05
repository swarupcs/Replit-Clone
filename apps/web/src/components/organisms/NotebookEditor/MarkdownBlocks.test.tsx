// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { parseMarkdown } from "../../../lib/notebookMarkdown.ts";
import { MarkdownBlocks } from "./MarkdownBlocks.tsx";

/** A notebook's prose cells, rendered.
 *
 *  These are mostly security tests, and that is the right emphasis: a markdown
 *  cell is content from a document somebody cloned, and the renderer is the
 *  only thing between it and this app's origin.
 */

function show(source: string) {
  return render(<MarkdownBlocks blocks={parseMarkdown(source)} />);
}

afterEach(cleanup);

describe("markup in a cloned notebook", () => {
  /** The claim `notebookMarkdown.ts` makes and this file has to keep. */
  it("renders a script tag as the characters of a script tag", () => {
    const { container } = show("Hello <script>alert(1)</script> there");

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders an img tag as text rather than fetching anything", () => {
    const { container } = show(`<img src=x onerror="alert(1)">`);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  /** A one-line XSS in any renderer that passes an href through.
   *
   *  Two separate things refuse it, and writing this test is what established
   *  which one actually fires. `parseInline` calls `safeHref` ITSELF, and on a
   *  refusal emits the whole `[text](url)` token as literal text -- so what
   *  reaches this component is not a link node with a bad href but a run of
   *  plain characters. The `safeHref` call in `MarkdownBlocks` is therefore a
   *  second line that the parser makes unreachable through `parseMarkdown`; it
   *  is kept because this component's prop is `Block[]`, which anything could
   *  construct, and it costs one call.
   *
   *  Asserted on the rendered TEXT rather than on "click me" alone, because
   *  the words are kept as part of the token rather than extracted from it. */
  it("refuses a javascript: link and renders it as characters", () => {
    const { container } = show("[click me](javascript:alert)");

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("[click me](javascript:alert)");
  });

  /** The realistic payload, which never becomes a link for a THIRD reason:
   *  `INLINE` matches a URL as `[^)\s]*`, so the closing paren inside
   *  `alert(1)` ends the match early and the line is never a link at all.
   *
   *  Safe for the wrong reason, which is worth pinning on its own. Widening
   *  that pattern later would move this case from the parser's failure to
   *  match onto `safeHref`, and this test is what would notice the shift. */
  it("also renders as text a javascript: url the link parser cannot match", () => {
    const { container } = show("[click me](javascript:alert(1))");

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("javascript:alert(1)");
  });

  /** The component's OWN `safeHref`, which nothing reaches through
   *  `parseMarkdown` because `parseInline` refuses a bad scheme first. Found by
   *  mutation-testing: deleting that check survived every test above, because
   *  every one of them goes through the parser.
   *
   *  Covered by handing the component a block directly, which is what its prop
   *  type allows and what a future caller -- an outline, a search result, a
   *  server-side render -- would do. A defence nothing tests is a defence that
   *  gets deleted as dead code. */
  it("refuses a bad href even in a block it did not parse", () => {
    const { container } = render(
      <MarkdownBlocks
        blocks={[
          {
            kind: "paragraph",
            inline: [
              { kind: "link", content: "click me", href: "javascript:alert(1)" },
            ],
          },
        ]}
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("click me")).toBeTruthy();
  });

  it("keeps an ordinary link, and opens it without a handle on this window", () => {
    show("[docs](https://example.com/a)");

    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

describe("what the document says", () => {
  /** The level is the notebook's own, so its outline navigates correctly for
   *  a screen reader rather than merely looking right. */
  it("renders a heading at the level the notebook wrote", () => {
    show("## Method");

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Method");
  });

  it("renders a list as a list", () => {
    show("- one\n- two");

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders a fenced block as preformatted code", () => {
    const { container } = show("```python\nx = 1\n```");

    const block = container.querySelector("pre code");
    expect(block?.textContent).toContain("x = 1");
  });

  it("renders emphasis rather than its asterisks", () => {
    const { container } = show("a **bold** word");

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.textContent).not.toContain("**");
  });
});
