import { describe, expect, it } from "vitest";
import {
  isFailure,
  promptLabel,
  renderBundle,
  stripAnsi,
} from "./notebookOutput.ts";

const ESC = "\u001B";

describe("stripping a kernel's colours", () => {
  /** IPython colours a traceback whenever it thinks it is talking to a
   *  terminal, and the driver is a pipe it decides is one. */
  it("removes the escapes IPython wraps a traceback in", () => {
    const raw = `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`;

    expect(stripAnsi(raw)).toBe("ZeroDivisionError: division by zero");
  });

  it("leaves text that merely contains brackets alone", () => {
    expect(stripAnsi("a[0]m = df[0:31]")).toBe("a[0]m = df[0:31]");
  });
});

describe("choosing what to show for one output", () => {
  it("prefers a PNG to the text repr beside it", () => {
    const rendered = renderBundle({
      "text/plain": "<Figure size 640x480>",
      "image/png": "iVBORw0KGgo=",
    });

    expect(rendered).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
      alt: "Output image",
    });
  });

  /** Jupyter wraps base64 across lines in the JSON, and a data URI with a
   *  newline in it is not a URI. */
  it("strips the line breaks Jupyter wrote into the base64", () => {
    const rendered = renderBundle({ "image/png": "iVBOR\nw0KG\ngo=\n" });

    expect(rendered).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
      alt: "Output image",
    });
  });

  /** THE decision in this file. A DataFrame's pretty rendering is HTML, and
   *  rendering it would mean putting markup from somebody's cloned repository
   *  into this app's origin. The plain-text table is the whole fallback. */
  it("renders the plain text of a DataFrame and never its HTML", () => {
    const rendered = renderBundle({
      "text/html": "<table><tr><td>1</td></tr></table>",
      "text/plain": "   a\n0  1",
    });

    expect(rendered).toEqual({ kind: "text", text: "   a\n0  1" });
  });

  /** The same argument in a less obvious costume: an SVG is a document that
   *  can carry script. */
  it("does not render an SVG, and says the output was not rendered", () => {
    const rendered = renderBundle({
      "image/svg+xml": "<svg onload='alert(1)'></svg>",
    });

    expect(rendered).toEqual({ kind: "unsupported", types: ["image/svg+xml"] });
  });

  it("names what a bundle held when it can render none of it", () => {
    const rendered = renderBundle({
      "application/vnd.plotly.v1+json": {},
      "text/latex": "$x$",
    });

    expect(rendered).toEqual({
      kind: "unsupported",
      types: ["application/vnd.plotly.v1+json", "text/latex"],
    });
  });

  /** nbformat stores text as a string or as an array of lines, in outputs as
   *  well as in sources. */
  it("joins a text repr stored as lines", () => {
    expect(renderBundle({ "text/plain": ["one\n", "two"] })).toEqual({
      kind: "text",
      text: "one\ntwo",
    });
  });

  it("strips escapes in a text repr too", () => {
    expect(renderBundle({ "text/plain": `${ESC}[1mbold${ESC}[0m` })).toEqual({
      kind: "text",
      text: "bold",
    });
  });

  /** A blank box under a cell that clearly produced something reads as a bug
   *  in the editor, so an empty sole representation falls through to saying
   *  what the bundle actually held. */
  it("reports the types rather than rendering an empty box", () => {
    expect(renderBundle({ "text/plain": "" })).toEqual({
      kind: "unsupported",
      types: ["text/plain"],
    });
  });
});

describe("the prompt in the gutter", () => {
  it("is a star while the cell is running, whatever it ran as before", () => {
    expect(promptLabel(7, true)).toBe("In [*]");
  });

  it("is empty for a cell that has never run", () => {
    expect(promptLabel(null, false)).toBe("In [ ]");
  });

  it("is the kernel's own counter otherwise", () => {
    expect(promptLabel(12, false)).toBe("In [12]");
  });
});

describe("what counts as a cell having failed", () => {
  it("is an error output", () => {
    expect(
      isFailure({ output_type: "error", ename: "E", evalue: "", traceback: [] }),
    ).toBe(true);
  });

  /** The one worth a test: warnings, logging and tqdm all write to stderr,
   *  and a cell that ran fine must not be marked as broken. */
  it("is not stderr", () => {
    expect(
      isFailure({ output_type: "stream", name: "stderr", source: "warning\n" }),
    ).toBe(false);
  });
});
