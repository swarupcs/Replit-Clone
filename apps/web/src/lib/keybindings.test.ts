import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  chordKey,
  conflicts,
  formatChord,
  isMac,
  resolveBindings,
} from "./keybindings.ts";

describe("formatChord", () => {
  it("writes a chord the way Windows and Linux menus do", () => {
    expect(formatChord({ key: "p", mod: true }, false)).toBe("Ctrl+P");
    expect(formatChord({ key: "p", mod: true, shift: true }, false)).toBe(
      "Ctrl+Shift+P",
    );
    expect(formatChord({ key: "w", mod: true, alt: true }, false)).toBe("Ctrl+Alt+W");
  });

  it("writes a chord the way a Mac does", () => {
    expect(formatChord({ key: "p", mod: true }, true)).toBe("⌘P");
    expect(formatChord({ key: "p", mod: true, shift: true }, true)).toBe("⇧⌘P");
  });

  it("spells a named key out rather than upper-casing one letter of it", () => {
    expect(formatChord({ key: "Tab", mod: true }, false)).toBe("Ctrl+Tab");
  });

  it("leaves punctuation alone", () => {
    expect(formatChord({ key: "`", mod: true }, false)).toBe("Ctrl+`");
  });
});

describe("isMac", () => {
  it.each(["MacIntel", "iPhone", "iPad"])("is true for %s", (platform) => {
    expect(isMac(platform)).toBe(true);
  });

  it.each(["Win32", "Linux x86_64", ""])("is false for %s", (platform) => {
    expect(isMac(platform)).toBe(false);
  });
});

describe("chordKey", () => {
  /** The same chord written with its modifiers in a different order is the
   *  same chord, and conflict detection depends on it comparing equal. */
  it("is stable across modifier order", () => {
    expect(chordKey({ key: "p", mod: true, shift: true })).toBe(
      chordKey({ shift: true, mod: true, key: "p" }),
    );
  });

  it("is case-insensitive on the key", () => {
    expect(chordKey({ key: "P", mod: true })).toBe(chordKey({ key: "p", mod: true }));
  });

  it("tells chords with different modifiers apart", () => {
    expect(chordKey({ key: "p", mod: true })).not.toBe(
      chordKey({ key: "p", mod: true, shift: true }),
    );
  });
});

describe("conflicts", () => {
  /** Two commands on one chord is not a crash: the first handler wins and
   *  the second silently never fires, which reads as a broken feature rather
   *  than a broken binding. */
  it("finds two commands sharing a chord", () => {
    expect(
      conflicts({ a: { key: "p", mod: true }, b: { key: "p", mod: true } }),
    ).toEqual([{ chord: "mod+p", commandIds: ["a", "b"] }]);
  });

  it("does not flag chords that only look alike", () => {
    expect(
      conflicts({ a: { key: "p", mod: true }, b: { key: "p", mod: true, shift: true } }),
    ).toEqual([]);
  });

  /** The guard this registry exists for. */
  it("finds no conflict among the shipped defaults", () => {
    expect(conflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
  });
});

describe("resolveBindings", () => {
  it("uses the defaults when nothing is overridden", () => {
    expect(resolveBindings({})).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("lets an override win", () => {
    const resolved = resolveBindings({ "go.file": { key: "o", mod: true } });
    expect(resolved["go.file"]).toEqual({ key: "o", mod: true });
  });

  it("leaves the others alone", () => {
    const resolved = resolveBindings({ "go.file": { key: "o", mod: true } });
    expect(resolved["view.sidebar"]).toEqual(DEFAULT_KEYBINDINGS["view.sidebar"]);
  });

  /** A binding for a command that no longer exists is invisible, and would
   *  surface only as a chord that mysteriously does nothing. */
  it("drops an override for a command that no longer exists", () => {
    const resolved = resolveBindings({ "removed-command": { key: "x", mod: true } });
    expect(resolved).not.toHaveProperty("removed-command");
  });
});
