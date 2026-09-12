import { useMemo } from "react";
import { parseMarkdown } from "../../../lib/notebookMarkdown.ts";
import { MarkdownBlocks } from "../../organisms/NotebookEditor/MarkdownBlocks.tsx";

/** A rendered view of a `.md` file. plan.md §10.14.
 *
 *  **Reuses the notebook's parser and renderer rather than adding a markdown
 *  library.** §2.42 already wrote both, and they were written for exactly this:
 *  a small, deliberately incomplete markdown that renders headings, lists,
 *  code, emphasis and links, with `safeHref` refusing a `javascript:` URL. A
 *  second markdown path would be a second place for that refusal to be got
 *  right — and the first thing anybody would reach for, `marked` plus
 *  `dompurify`, is two dependencies and an `innerHTML` in front of content
 *  from a repository this platform did not write.
 *
 *  What it does not render, because the parser does not: tables, footnotes,
 *  block quotes, images, HTML. Named here so the gap is a known one.
 */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div
      className="rc-markdown-preview"
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "16px 20px",
        // A column of prose rather than the full width of a wide editor: a
        // 200-character line of text is one nobody's eye tracks back across.
        maxWidth: 820,
      }}
    >
      <MarkdownBlocks blocks={blocks} />
    </div>
  );
}

export default MarkdownPreview;
