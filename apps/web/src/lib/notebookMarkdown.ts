/** Just enough Markdown for a notebook's prose cells. plan.md §12.3.
 *
 *  `AiPanel/markdown.ts` already argues the position this follows: a full
 *  Markdown renderer is a dependency and an XSS surface, and for an
 *  assistant's answer the only thing that earns its place is the code block.
 *  A notebook is the case where the rest of it does earn its place — the
 *  markdown cells are the document, and rendering a `# Method` heading as the
 *  literal text `# Method` is not a rendered notebook.
 *
 *  So: the same stance, a wider subset. **This produces structured nodes, not
 *  HTML.** Nothing here ever returns a string that a caller could be tempted
 *  to put through `dangerouslySetInnerHTML`, which is the property that makes
 *  the XSS argument hold no matter what a cloned repository's notebook
 *  contains.
 *
 *  What is deliberately absent: tables, images, blockquotes, footnotes,
 *  reference links, raw HTML. Raw HTML is the important absence — real
 *  notebooks do contain `<img src=...>` in markdown cells, and it renders here
 *  as its own text rather than as markup.
 */

export interface InlineText {
  kind: "text";
  content: string;
}
export interface InlineCode {
  kind: "code";
  content: string;
}
export interface InlineEmphasis {
  kind: "strong" | "em";
  content: string;
}
export interface InlineLink {
  kind: "link";
  content: string;
  href: string;
}

export type Inline = InlineText | InlineCode | InlineEmphasis | InlineLink;

export interface HeadingBlock {
  kind: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  inline: Inline[];
}
export interface ParagraphBlock {
  kind: "paragraph";
  inline: Inline[];
}
export interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: Inline[][];
}
export interface CodeBlock {
  kind: "code";
  language?: string;
  content: string;
}
export interface RuleBlock {
  kind: "rule";
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | RuleBlock;

/** Only http(s) and mailto survive.
 *
 *  A markdown cell is content from a repository, and `[click](javascript:...)`
 *  is a one-line XSS in any renderer that passes an href straight through.
 *  Anything else becomes plain text, which is visible and harmless. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  // A scheme-relative or relative URL is fine; a scheme that is not on the
  // list is not. Tested by parsing rather than by pattern, so tricks like
  // "java\tscript:" resolve before they are judged.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(":")).toLowerCase();
    if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") {
      return null;
    }
  }
  return trimmed;
}

const INLINE =
  /(`[^`]+`)|(\[[^\]]*\]\([^)\s]*\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;

  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      out.push({ kind: "text", content: rest });
      break;
    }

    if (match.index > 0) {
      out.push({ kind: "text", content: rest.slice(0, match.index) });
    }

    const token = match[0];

    if (token.startsWith("`")) {
      out.push({ kind: "code", content: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const text = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      out.push(
        href === null
          ? { kind: "text", content: token }
          : { kind: "link", content: text, href },
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push({ kind: "strong", content: token.slice(2, -2) });
    } else {
      out.push({ kind: "em", content: token.slice(1, -1) });
    }

    rest = rest.slice(match.index + token.length);
  }

  return out.filter((node) => node.kind !== "text" || node.content !== "");
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBER = /^ {0,3}\d+[.)]\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { language?: string; lines: string[]; fence: string } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    if (text !== "") blocks.push({ kind: "paragraph", inline: parseInline(text) });
    paragraph = [];
  };

  const flushList = (): void => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      items: list.items.map(parseInline),
    });
    list = null;
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (code) {
      // Inside a fence, everything is content until a matching fence. A `#`
      // in a code block is a comment, not a heading.
      const fence = FENCE.exec(line);
      if (fence && fence[1]?.[0] === code.fence[0] && fence[2]?.trim() === "") {
        blocks.push({
          kind: "code",
          language: code.language,
          content: code.lines.join("\n"),
        });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const info = fence[2]?.trim();
      code = {
        language: info === "" ? undefined : info,
        lines: [],
        fence: fence[1] ?? "```",
      };
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: (heading[1]?.length ?? 1) as HeadingBlock["level"],
        inline: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBER.exec(line);
    if (bullet ?? numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const item = (ordered ? numbered?.[1] : bullet?.[1]) ?? "";
      // A list that changes kind mid-way is two lists, which is what every
      // renderer does and what the author meant.
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  // A fence the cell never closed. Its content is still the author's text and
  // showing it as code is closer to what they wrote than showing it as prose.
  if (code) {
    blocks.push({
      kind: "code",
      language: code.language,
      content: code.lines.join("\n"),
    });
  }
  flushAll();

  return blocks;
}
