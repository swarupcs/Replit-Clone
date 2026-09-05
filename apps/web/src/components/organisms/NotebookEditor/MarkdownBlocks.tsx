import type { Block, Inline } from "../../../lib/notebookMarkdown.ts";
import { safeHref } from "../../../lib/notebookMarkdown.ts";

/** Renders `notebookMarkdown`'s nodes as React. plan.md §12.3.
 *
 *  The counterpart to that file's central claim, and the reason it produces
 *  nodes rather than an HTML string: **there is no `dangerouslySetInnerHTML`
 *  anywhere in this file, and there is nowhere one could be added.** Every
 *  branch below ends in a React element with text children, so a markdown cell
 *  containing `<script>` renders as the characters `<script>`. That property
 *  holds no matter what a cloned repository's notebook contains, which is the
 *  only kind of guarantee worth having here.
 */

function InlineRun({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <code key={index} className="rc-nb-inline-code">
              {node.content}
            </code>
          );
        }
        if (node.kind === "strong") return <strong key={index}>{node.content}</strong>;
        if (node.kind === "em") return <em key={index}>{node.content}</em>;
        if (node.kind === "link") {
          const href = safeHref(node.href);
          // A refused scheme renders as the link's own text. Not dropped: the
          // words were part of a sentence, and removing them changes what the
          // document says rather than only how it looks.
          if (href === null) return <span key={index}>{node.content}</span>;
          return (
            <a
              key={index}
              href={href}
              // A notebook is somebody else's document and the link goes off
              // this origin. `noopener` is the one that matters -- without it
              // the opened page gets a handle on this window.
              target="_blank"
              rel="noopener noreferrer"
            >
              {node.content}
            </a>
          );
        }
        return <span key={index}>{node.content}</span>;
      })}
    </>
  );
}

export function MarkdownBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="rc-nb-markdown">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          // The level is the document's, so the notebook's own outline is what
          // a screen reader hears. Rendering everything as an h3 with
          // different font sizes would look identical and navigate wrongly.
          const Tag = `h${String(block.level)}` as "h1";
          return (
            <Tag key={index}>
              <InlineRun nodes={block.inline} />
            </Tag>
          );
        }

        if (block.kind === "paragraph") {
          return (
            <p key={index}>
              <InlineRun nodes={block.inline} />
            </p>
          );
        }

        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineRun nodes={item} />
                </li>
              ))}
            </Tag>
          );
        }

        if (block.kind === "code") {
          return (
            <pre key={index} className="rc-nb-md-code">
              <code>{block.content}</code>
            </pre>
          );
        }

        return <hr key={index} />;
      })}
    </div>
  );
}
