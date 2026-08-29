import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import dracula from "./theme/dracula.json";
import alucard from "./theme/alucard.json";

const css = readFileSync(
  fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);

/** Relative luminance, per WCAG. Used to assert direction — that a light
 *  theme's ink is dark on light paper — rather than to grade contrast, which
 *  a designer's eye settles better than a threshold does. */
function luminance(hex: string): number {
  const to = (pair: string) => {
    const channel = parseInt(pair, 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const clean = hex.replace("#", "").slice(0, 6);
  return (
    0.2126 * to(clean.slice(0, 2)) +
    0.7152 * to(clean.slice(2, 4)) +
    0.0722 * to(clean.slice(4, 6))
  );
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

describe("the light editor theme", () => {
  /** The reason it is generated from Dracula rather than written beside it:
   *  a hand-written second theme drifts, and the token nobody remembered is
   *  the one that falls back to an unreadable inherited colour. */
  it("covers exactly the tokens the dark theme does", () => {
    expect(alucard.rules.map((rule) => rule.token)).toEqual(
      dracula.rules.map((rule) => rule.token),
    );
  });

  it("is a light theme, not the dark one relabelled", () => {
    expect(alucard.base).toBe("vs");
    expect(luminance(alucard.colors["editor.background"])).toBeGreaterThan(0.8);
    expect(luminance(alucard.colors["editor.foreground"])).toBeLessThan(0.1);
  });

  it("carries every token colour against its own background", () => {
    const background = alucard.colors["editor.background"];

    for (const rule of alucard.rules) {
      if (!rule.foreground) continue;
      // 4.5:1 is the AA threshold for body text, and code is body text.
      expect(
        contrast(`#${rule.foreground}`, background),
        `"${rule.token || "default"}" is ${contrast(`#${rule.foreground}`, background).toFixed(2)}:1 on the editor background`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  /** The one theming gap with an actual bug in it: the diff editor's colours
   *  are inherited when unset, and the dark defaults are near-illegible on
   *  white. Naming them is the fix. */
  it("states the diff editor's colours rather than inheriting them", () => {
    for (const key of [
      "diffEditor.insertedTextBackground",
      "diffEditor.removedTextBackground",
      "diffEditor.insertedLineBackground",
      "diffEditor.removedLineBackground",
    ]) {
      expect(alucard.colors, key).toHaveProperty(key);
    }
  });

  it("matches the app's own light editor background", () => {
    // Otherwise the editor sits as a differently-lit rectangle inside the app.
    const light = css.slice(css.indexOf(':root[data-theme="light"] {'));
    const declared = /--rc-editor-bg:\s*(#[0-9a-f]{6})/i.exec(light)?.[1];
    expect(declared?.toLowerCase()).toBe(
      alucard.colors["editor.background"].toLowerCase(),
    );
  });
});

describe("the accessibility media queries", () => {
  it("stands motion down for anyone who asked", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("animation-duration: 0.01ms !important");
  });

  /** A progress indicator that stops looks like a hang, so the two spinners
   *  keep turning — slower. Named selectors rather than a class that sounds
   *  right: an exemption pointed at nothing is worse than none, because it
   *  reads as handled. */
  it("keeps the progress indicators turning", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [
      '.rc-icon-button[data-spinning="true"] svg',
      ".rc-preview-progress::after",
    ]) {
      expect(block, selector).toContain(selector);
      // The selector has to exist outside the media query too, or the
      // exemption is pointed at nothing.
      expect(css.indexOf(selector), selector).toBeLessThan(
        css.indexOf("@media (prefers-reduced-motion: reduce)"),
      );
    }
  });

  /** The same failure the reduced-motion exemption nearly shipped with: a
   *  rule pointed at a class nobody sets does nothing and reads as handled.
   *  Every selector zen mode hides has to exist somewhere else. */
  it("hides only things that exist", () => {
    const block = css.slice(css.indexOf("/* Zen mode."));
    const zen = block.slice(0, block.indexOf("}") + 1);

    for (const selector of [".rc-drawer-left", ".rc-drawer-bottom", ".rc-statusbar"]) {
      expect(zen, `zen does not hide ${selector}`).toContain(selector);
      // Declared elsewhere in the sheet, which is the proof it is a real
      // class rather than one invented for this rule.
      expect(
        css.indexOf(`${selector} {`) !== -1 || css.indexOf(`${selector},`) !== -1,
        `${selector} is not defined anywhere`,
      ).toBe(true);
    }
  });

  it("raises contrast for anyone who asked, in both themes", () => {
    expect(css).toContain("@media (prefers-contrast: more)");
    const block = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    expect(block).toContain(":root[data-theme=\"light\"]");
    expect(block).toContain("--rc-border");
  });
});
