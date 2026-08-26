import type { ThemeMode } from "../store/themeStore.ts";

/** xterm paints to its own canvas and cannot read a CSS custom property, so
 *  each palette mirrors the `--rc-*` tokens for its theme by hand.
 *
 *  The light one is not the dark one lightened: ANSI colours picked to be
 *  legible on near-black are washed out on white, so the light palette takes
 *  them several steps darker. */
export const TERMINAL_THEME: Record<ThemeMode, Record<string, string>> = {
  dark: {
    background: "#0a0b12",
    foreground: "#e6e8f0",
    cursor: "#a78bfa",
    cursorAccent: "#0a0b12",
    selectionBackground: "#2a2e42",
    black: "#0a0b12",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#a78bfa",
    cyan: "#22d3ee",
    white: "#e6e8f0",
    brightBlack: "#6b7192",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fcd34d",
    brightBlue: "#93c5fd",
    brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#131623",
    cursor: "#6d28d9",
    cursorAccent: "#ffffff",
    selectionBackground: "#dbe4fa",
    black: "#131623",
    red: "#c02626",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#1d4ed8",
    magenta: "#7c3aed",
    cyan: "#0e7490",
    white: "#6f778f",
    brightBlack: "#4a5169",
    brightRed: "#dc2626",
    brightGreen: "#16a34a",
    brightYellow: "#b45309",
    brightBlue: "#2563eb",
    brightMagenta: "#9333ea",
    brightCyan: "#0891b2",
    brightWhite: "#131623",
  },
};
