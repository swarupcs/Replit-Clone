// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useThemeMode } from "./useThemeMode.ts";
import { resolveMode, useThemeStore } from "../store/themeStore.ts";
import { antdThemeFor } from "../config/theme.ts";
import { TERMINAL_THEME } from "../lib/terminalTheme.ts";

/** jsdom ships no `matchMedia`, so the OS preference has to be installed. */
function systemPrefers(scheme: "light" | "dark") {
  window.matchMedia = (query: string) => ({
    media: query,
    matches: query.includes("prefers-color-scheme: light")
      ? scheme === "light"
      : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  });
}

const Probe = () => <span>{useThemeMode()}</span>;

beforeEach(() => {
  useThemeStore.setState({ choice: "system" });
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
  // @ts-expect-error -- putting jsdom back the way it was found.
  delete window.matchMedia;
});

describe("resolveMode", () => {
  it("takes an explicit choice at its word", () => {
    systemPrefers("light");
    expect(resolveMode("dark")).toBe("dark");
    expect(resolveMode("light")).toBe("light");
  });

  it("follows the operating system when asked to", () => {
    systemPrefers("light");
    expect(resolveMode("system")).toBe("light");

    systemPrefers("dark");
    expect(resolveMode("system")).toBe("dark");
  });

  it("defaults to dark where the question cannot be asked", () => {
    // No matchMedia at all — a very old browser, or a test that installed
    // none. The app is designed dark-first, so that is the safer guess.
    expect(resolveMode("system")).toBe("dark");
  });
});

describe("useThemeMode", () => {
  it("stamps the resolved mode on the document", () => {
    systemPrefers("light");
    render(<Probe />);

    // This attribute is what every CSS token hangs off; without it the light
    // block never applies however the store is set.
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("lets a stored choice override the system", () => {
    systemPrefers("light");
    useThemeStore.setState({ choice: "dark" });
    render(<Probe />);

    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});

describe("what each half of the app is given", () => {
  it("hands antd a light algorithm and a darker primary", () => {
    const light = antdThemeFor("light");
    const dark = antdThemeFor("dark");

    expect(light.algorithm).not.toBe(dark.algorithm);
    // #8b5cf6 on white does not carry enough contrast for text, and antd uses
    // the primary colour for both fills and text.
    expect(light.token?.colorPrimary).not.toBe(dark.token?.colorPrimary);
  });

  it("keeps the structural tokens the same in both", () => {
    const light = antdThemeFor("light");
    const dark = antdThemeFor("dark");

    // Radii, control height and fonts are the design system, not the palette.
    expect(light.token?.borderRadius).toBe(dark.token?.borderRadius);
    expect(light.token?.controlHeight).toBe(dark.token?.controlHeight);
    expect(light.token?.fontFamily).toBe(dark.token?.fontFamily);
  });

  it("gives the terminal a palette per theme, not one lightened", () => {
    // ANSI colours picked to read on near-black are washed out on white.
    expect(TERMINAL_THEME.light["background"]).not.toBe(
      TERMINAL_THEME.dark["background"],
    );
    expect(TERMINAL_THEME.light["green"]).not.toBe(TERMINAL_THEME.dark["green"]);

    // Both define the same keys, so neither leaves a slot to xterm's default.
    expect(Object.keys(TERMINAL_THEME.light).sort()).toEqual(
      Object.keys(TERMINAL_THEME.dark).sort(),
    );
  });
});
