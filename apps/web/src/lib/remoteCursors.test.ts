// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCursorStyles,
  cssString,
  renderCursorStyles,
  resetCursorStyles,
  safeColor,
} from "./remoteCursors.ts";

const FALLBACK = "hsl(265 70% 62%)";

beforeEach(() => {
  resetCursorStyles();
  document.getElementById("rc-remote-cursors")?.remove();
});

describe("colours that arrive from another client", () => {
  it("keeps the forms this app actually produces", () => {
    expect(safeColor("hsl(265 70% 62%)", FALLBACK)).toBe("hsl(265 70% 62%)");
    expect(safeColor("#ff8800", FALLBACK)).toBe("#ff8800");
    expect(safeColor("#f80", FALLBACK)).toBe("#f80");
    expect(safeColor("rgb(255, 136, 0)", FALLBACK)).toBe("rgb(255, 136, 0)");
  });

  /** The reason this function exists.
   *
   *  The colour is interpolated into a stylesheet, and it came from another
   *  client's awareness rather than from anything this app generated. A peer
   *  who closes the declaration can write rules of their own into the page —
   *  hiding the editor, covering it with an overlay, restyling a dialog into
   *  something it is not.
   */
  it("refuses a colour that closes the declaration", () => {
    const attack = "red; } body { display: none } .x {";
    expect(safeColor(attack, FALLBACK)).toBe(FALLBACK);

    // And the whole point: it must not reach the stylesheet either.
    const css = renderCursorStyles([
      { clientId: 7, name: "a@b.c", color: safeColor(attack, FALLBACK) },
    ]);
    expect(css).not.toContain("display: none");
  });

  it("refuses anything that is not a colour at all", () => {
    expect(safeColor(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeColor(null, FALLBACK)).toBe(FALLBACK);
    expect(safeColor(42, FALLBACK)).toBe(FALLBACK);
    expect(safeColor("", FALLBACK)).toBe(FALLBACK);
    expect(safeColor("url(https://elsewhere/x)", FALLBACK)).toBe(FALLBACK);
    expect(safeColor("rebeccapurple", FALLBACK)).toBe(FALLBACK);
  });
});

describe("a name in a CSS string", () => {
  it("quotes an ordinary name", () => {
    expect(cssString("ada@example.com")).toBe('"ada@example.com"');
  });

  /** Same argument as the colour: an account email cannot contain a quote,
   *  but this name came off the wire rather than out of the signup form. */
  it("escapes a name that would close the string", () => {
    expect(cssString('a"; color: red; content: "')).toBe(
      '"a\\"; color: red; content: \\""',
    );
    expect(cssString("back\\slash")).toBe('"back\\\\slash"');
  });

  it("does not let a newline end the declaration", () => {
    expect(cssString("a\nb")).toBe('"a b"');
    expect(cssString("a\r\nb")).toBe('"a  b"');
  });
});

describe("the rules for one remote cursor", () => {
  const CURSOR = { clientId: 4211, name: "ada@example.com", color: "#ff8800" };

  /** The class names carry the client id, which is what makes one person's
   *  caret a different colour from another's. A rule set that named the bare
   *  classes would paint everybody the same and would be invisible to any
   *  assertion that only checked a colour appeared somewhere. */
  it("scopes every rule to that client id", () => {
    const css = renderCursorStyles([CURSOR]);

    expect(css).toContain(".yRemoteSelection-4211 {");
    expect(css).toContain(".yRemoteSelectionHead-4211 {");
    expect(css).toContain(".yRemoteSelectionHead-4211::after {");
  });

  it("tints the selection and draws a caret in their colour", () => {
    const css = renderCursorStyles([CURSOR]);

    expect(css).toContain("#ff8800 28%");
    expect(css).toContain("border-left: 2px solid #ff8800;");
  });

  it("labels the caret with their name", () => {
    expect(renderCursorStyles([CURSOR])).toContain(
      'content: "ada@example.com";',
    );
  });

  /** The label hangs over the line above, which is somebody's own code. If it
   *  took pointer events, clicking that line would hit the label instead. */
  it("keeps the label out of the way of clicks", () => {
    expect(renderCursorStyles([CURSOR])).toContain("pointer-events: none;");
  });

  it("gives two people two independent rule sets", () => {
    const css = renderCursorStyles([
      CURSOR,
      { clientId: 9, name: "grace@example.com", color: "#00c2ff" },
    ]);

    expect(css).toContain(".yRemoteSelection-4211 {");
    expect(css).toContain(".yRemoteSelection-9 {");
    expect(css).toContain("#ff8800 28%");
    expect(css).toContain("#00c2ff 28%");
  });

  it("renders nothing when nobody else is here", () => {
    expect(renderCursorStyles([])).toBe("");
  });
});

describe("installing the rules", () => {
  function sheet(): HTMLElement | null {
    return document.getElementById("rc-remote-cursors");
  }

  it("puts one stylesheet in the head", () => {
    applyCursorStyles([{ clientId: 1, name: "a@b.c", color: "#ff8800" }]);

    expect(sheet()?.tagName).toBe("STYLE");
    expect(sheet()?.textContent).toContain(".yRemoteSelection-1 {");
    expect(document.querySelectorAll("#rc-remote-cursors")).toHaveLength(1);
  });

  it("reuses that stylesheet rather than adding another", () => {
    applyCursorStyles([{ clientId: 1, name: "a@b.c", color: "#ff8800" }]);
    applyCursorStyles([{ clientId: 2, name: "c@d.e", color: "#00c2ff" }]);

    expect(document.querySelectorAll("#rc-remote-cursors")).toHaveLength(1);
    expect(sheet()?.textContent).toContain(".yRemoteSelection-2 {");
    expect(sheet()?.textContent).not.toContain(".yRemoteSelection-1 {");
  });

  /** Awareness fires on every keystroke of every collaborator, and almost none
   *  of those change who is present. Rewriting `textContent` each time would
   *  invalidate the document's style for every one of them. */
  it("does not rewrite the sheet when nothing visible changed", () => {
    const cursors = [{ clientId: 1, name: "a@b.c", color: "#ff8800" }];
    applyCursorStyles(cursors);

    const marker = "/* untouched */";
    const style = sheet();
    if (style) style.textContent = marker;

    applyCursorStyles([{ clientId: 1, name: "a@b.c", color: "#ff8800" }]);
    expect(sheet()?.textContent).toBe(marker);
  });

  it("clears the rules when the last collaborator leaves", () => {
    applyCursorStyles([{ clientId: 1, name: "a@b.c", color: "#ff8800" }]);
    applyCursorStyles([]);

    expect(sheet()?.textContent).toBe("");
  });
});
