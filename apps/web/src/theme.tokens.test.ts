import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The token sheet, read as text: what this is about is which declarations
 *  exist, and jsdom applies no stylesheet a test could inspect instead. */
const css = readFileSync(
  fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** The custom properties declared in one selector's block. */
function tokensIn(selector: string): string[] {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no ${selector} block in index.css`);

  const block = css.slice(at, css.indexOf("\n}", at));
  return [...block.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1] ?? "");
}

/** Tokens the light theme deliberately shares, because they are the design
 *  system rather than the palette: geometry, type and motion do not change
 *  with the lights. */
const SHARED = new Set([
  "--rc-radius-sm",
  "--rc-radius",
  "--rc-radius-lg",
  "--rc-sans",
  "--rc-mono",
  "--rc-ease",
]);

describe("the light theme", () => {
  /** The failure this exists for: a token added to `:root` and forgotten in
   *  the light block does not error — it inherits the dark value, and shows up
   *  as one unreadable thing on an otherwise light page. */
  it("gives every palette token a light value", () => {
    const light = new Set(tokensIn(':root[data-theme="light"]'));

    const missing = tokensIn(":root").filter(
      (token) => !SHARED.has(token) && !light.has(token),
    );

    expect(missing).toEqual([]);
  });

  it("introduces no token the dark theme does not have", () => {
    // A light-only token is a value nothing falls back to in the dark.
    const dark = new Set(tokensIn(":root"));
    const extra = tokensIn(':root[data-theme="light"]').filter(
      (token) => !dark.has(token),
    );

    expect(extra).toEqual([]);
  });
});
