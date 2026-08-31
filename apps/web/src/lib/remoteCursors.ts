/** Making other people's cursors visible.
 *
 *  `MonacoBinding` has been publishing every local selection into awareness
 *  and decorating every remote one since collaborative editing shipped. It
 *  tags each decoration `yRemoteSelection-<clientID>` and
 *  `yRemoteSelectionHead-<clientID>` — a class per person, deliberately, so
 *  that the colour can differ per person.
 *
 *  y-monaco ships no stylesheet for those classes and there was none here
 *  either, so every remote selection has been rendering as an unstyled span:
 *  present in the DOM, invisible on screen. The transport was never the
 *  missing half. This is.
 *
 *  The rules have to be generated rather than written once, because the class
 *  name contains a client id that is only known at runtime and the colour is
 *  per person.
 */

/** A person's cursor, as one rule set needs it. */
export interface CursorStyle {
  clientId: number;
  name: string;
  color: string;
}

/** Colours arrive over the wire from another client's awareness, and they are
 *  about to be interpolated into a stylesheet. A peer that sets its colour to
 *  `red } body { display: none } .x {` would otherwise be writing CSS into
 *  this document.
 *
 *  So the value is not escaped, it is *matched*: hex, `rgb()`, and `hsl()` in
 *  the forms this app actually produces, and nothing else. Anything that does
 *  not match is not repaired — it is replaced by the caller's fallback, which
 *  is the deterministic colour derived from the person's name.
 */
const COLOR_RE =
  /^(#[0-9a-f]{3,8}|rgb\(\s*[\d.\s,%/]+\)|hsl\(\s*[\d.\s,%/]+\))$/i;

export function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && COLOR_RE.test(value.trim())
    ? value.trim()
    : fallback;
}

/** A CSS string literal for `content:`.
 *
 *  Names are account emails, which cannot contain a quote or a backslash — but
 *  "cannot" here means "the signup form does not allow it", and the name on
 *  this path came from another client rather than from the form. Escaped
 *  properly so that stays a fact about the data and not a fact this code
 *  depends on.
 */
export function cssString(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // A raw newline terminates a CSS string and would leave the rest of the
    // rule as stray declarations.
    .replace(/[\r\n]/g, " ");

  return `"${escaped}"`;
}

/** The stylesheet for a set of remote cursors.
 *
 *  Pure, so the rules can be asserted on without a DOM. `applyCursorStyles`
 *  is the half that touches the document.
 */
export function renderCursorStyles(cursors: CursorStyle[]): string {
  return cursors
    .map(({ clientId, name, color }) => {
      const tint = `color-mix(in srgb, ${color} 28%, transparent)`;

      return [
        // The selected range itself. Tinted rather than filled, because the
        // text underneath it still has to be readable — this sits over
        // syntax-highlighted code, not over a blank page.
        `.yRemoteSelection-${String(clientId)} {`,
        `  background-color: ${tint};`,
        `}`,
        // The caret. Monaco renders this as a zero-width span at the head of
        // the selection, so it is positioned rather than laid out.
        `.yRemoteSelectionHead-${String(clientId)} {`,
        `  position: absolute;`,
        `  border-left: 2px solid ${color};`,
        `  height: 100%;`,
        `  box-sizing: border-box;`,
        `}`,
        // Whose it is. Without a label a second colour is just a second
        // colour; with four people in a file, colour alone stops answering
        // the question anyone actually has.
        `.yRemoteSelectionHead-${String(clientId)}::after {`,
        `  content: ${cssString(name)};`,
        `  position: absolute;`,
        `  left: -2px;`,
        `  top: -1.15em;`,
        `  padding: 0 4px;`,
        `  font-size: 10px;`,
        `  line-height: 1.15em;`,
        `  white-space: nowrap;`,
        `  border-radius: 3px 3px 3px 0;`,
        `  background: ${color};`,
        `  color: #10121b;`,
        // The label overhangs the line above, where the user's own caret and
        // text are. It must never swallow a click meant for the code.
        `  pointer-events: none;`,
        `  z-index: 20;`,
        `}`,
      ].join("\n");
    })
    .join("\n\n");
}

const STYLE_ID = "rc-remote-cursors";

/** Last text written, so an awareness update that changed nothing visible —
 *  which is most of them, since every keystroke moves a selection — does not
 *  touch the stylesheet and force a restyle of the editor. */
let lastCss: string | null = null;

/** Installs the rules for everyone currently visible.
 *
 *  One stylesheet for the whole app rather than one per document: the same
 *  person in two files is two client ids, and both need a rule, but they are
 *  the same colour and the same name.
 */
export function applyCursorStyles(cursors: CursorStyle[]): void {
  if (typeof document === "undefined") return;

  const css = renderCursorStyles(cursors);
  if (css === lastCss) return;
  lastCss = css;

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }

  style.textContent = css;
}

/** Test seam. The cache above is module state, and a suite that asserts on
 *  the stylesheet twice would otherwise see the second write skipped. */
export function resetCursorStyles(): void {
  lastCss = null;
}
