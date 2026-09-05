import type { MimeBundle, NotebookOutput } from "@replit-clone/shared";

/** Choosing what to show for one notebook output, and making it safe to show.
 *
 *  plan.md §12.3. Separated from the component for the reason the rest of this
 *  app separates its rendering decisions: the interesting part is the choice
 *  of representation, and a choice is worth testing without a DOM.
 */

/** CSI sequences, which is all a kernel traceback contains.
 *
 *  IPython colours its tracebacks unconditionally when it thinks it is talking
 *  to a terminal, and `rc-kernel` is a pipe that it decides is one. So a
 *  traceback arrives as `\u001B[0;31mZeroDivisionError\u001B[0m` and rendering
 *  it literally puts `[0;31m` in front of the only line of the output anybody
 *  reads.
 *
 *  Stripped rather than translated to colour. The terminal pane has xterm for
 *  that; a notebook output is a block of text in a document, and the palette
 *  it would bring is IPython's rather than this app's.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** What a MIME bundle is going to be rendered as. */
export type Rendered =
  /** A data URI for an `<img>`. */
  | { kind: "image"; src: string; alt: string }
  | { kind: "text"; text: string }
  /** The bundle had representations, and none this renders. Named rather than
   *  dropped: an empty box under a cell that clearly produced something reads
   *  as a bug in the editor. */
  | { kind: "unsupported"; types: string[] };

/** Preference order, and the omissions are the decision.
 *
 *  `text/html` is **deliberately not here**, and it is the one people will ask
 *  about, because a pandas DataFrame's nice rendering is HTML. Putting it in
 *  means `dangerouslySetInnerHTML` over a document that may have come out of a
 *  cloned repository — arbitrary markup, arbitrary `<script>`, arbitrary
 *  `onerror=`, running on this app's origin with this app's session. That is
 *  the same argument `notebookMarkdown.ts` makes about markdown cells, and it
 *  does not get weaker because the output is prettier.
 *
 *  Every `text/html` output that matters carries a `text/plain` beside it —
 *  nbformat's convention, and pandas, matplotlib and sympy all honour it — so
 *  the fallback is the ASCII table rather than nothing.
 *
 *  `image/svg+xml` is absent for the same reason in a less obvious costume: an
 *  SVG is a document that can carry script, and matplotlib writes PNG unless
 *  told otherwise.
 */
const PREFERENCE = ["image/png", "image/jpeg", "text/plain"] as const;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

/** nbformat stores text as a string or an array of lines, in outputs too. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === "string" ? line : "")).join("");
  }
  return "";
}

export function renderBundle(data: MimeBundle): Rendered {
  for (const type of PREFERENCE) {
    const value = data[type];
    if (value === undefined || value === null) continue;

    if (IMAGE_TYPES.has(type)) {
      // Base64 already, and nbformat says so — but it arrives with the line
      // breaks Jupyter wrote into the JSON, and a data URI containing a
      // newline is not a URI. Browsers vary on whether they forgive it.
      const base64 = asText(value).replace(/\s/g, "");
      if (base64 === "") continue;
      return {
        kind: "image",
        src: `data:${type};base64,${base64}`,
        // Not decorative: a plot IS the output, and a screen reader that
        // announces nothing here reports a cell that produced nothing.
        alt: "Output image",
      };
    }

    const text = asText(value);
    // An empty `text/plain` is a real thing -- `print()` of nothing -- but as
    // the ONLY representation it renders as a blank box, so fall through to
    // reporting what the bundle actually held.
    if (text === "") continue;
    return { kind: "text", text: stripAnsi(text) };
  }

  return { kind: "unsupported", types: Object.keys(data).sort() };
}

/** The `In [n]` / `Out[n]` gutter label for a cell. */
export function promptLabel(count: number | null, running: boolean): string {
  if (running) return "In [*]";
  return count === null ? "In [ ]" : `In [${String(count)}]`;
}

/** Whether this output means the cell failed, for the cell's own styling.
 *
 *  `stderr` is not a failure: warnings, progress bars and tqdm all write
 *  there, and a cell that ran fine would otherwise be marked as broken.
 */
export function isFailure(output: NotebookOutput): boolean {
  return output.output_type === "error";
}
