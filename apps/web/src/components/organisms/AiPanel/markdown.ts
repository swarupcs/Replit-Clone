/** Just enough Markdown for a coding assistant: fenced code blocks.
 *
 *  A full Markdown renderer is a dependency and an XSS surface, and almost
 *  none of it earns its place here — what matters in an answer about code is
 *  that the code is monospaced, kept intact, and copyable in one click. Prose
 *  renders as plain text, so nothing the model emits is ever interpreted as
 *  markup.
 *
 *  Written as a pure function so the parsing is testable without a DOM.
 */

export interface TextSegment {
  kind: "text";
  content: string;
}

export interface CodeSegment {
  kind: "code";
  /** The fence's info string, when it named one. */
  language?: string;
  content: string;
  /** False while the closing fence has not arrived yet, which is the normal
   *  state mid-stream. Lets the UI show the block as still being written
   *  rather than flickering between prose and code on every chunk. */
  closed: boolean;
}

export type Segment = TextSegment | CodeSegment;

/** A fence is three or more backticks at the start of a line. */
const FENCE = /^ {0,3}(`{3,})(.*)$/;

export function parseSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  const lines = source.split("\n");

  let text: string[] = [];
  let code: string[] | null = null;
  let language: string | undefined;
  let fence = "";

  const flushText = (): void => {
    const content = text.join("\n");
    // Whitespace between blocks is layout, not content.
    if (content.trim() !== "") segments.push({ kind: "text", content });
    text = [];
  };

  for (const line of lines) {
    const match = FENCE.exec(line);

    if (code === null) {
      if (match) {
        flushText();
        fence = match[1] ?? "```";
        language = match[2]?.trim() || undefined;
        code = [];
        continue;
      }
      text.push(line);
      continue;
    }

    // Inside a block: only a fence at least as long as the opening one closes
    // it, so ``` inside a ````-fenced example stays part of the example.
    if (match && (match[1]?.length ?? 0) >= fence.length && match[2]?.trim() === "") {
      segments.push({
        kind: "code",
        ...(language ? { language } : {}),
        content: code.join("\n"),
        closed: true,
      });
      code = null;
      language = undefined;
      continue;
    }

    code.push(line);
  }

  if (code !== null) {
    // Streaming: the block is still open. Emitted anyway so the user watches
    // the code arrive instead of staring at nothing until the fence lands.
    segments.push({
      kind: "code",
      ...(language ? { language } : {}),
      content: code.join("\n"),
      closed: false,
    });
  } else {
    flushText();
  }

  return segments;
}
