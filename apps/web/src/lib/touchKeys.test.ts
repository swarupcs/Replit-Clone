import { describe, expect, it } from "vitest";
import {
  TOUCH_KEYS,
  controlByte,
  pressCharacter,
  pressTouchKey,
} from "./touchKeys.ts";

/** §13.10's sharpest concrete complaint is "a terminal with no `Ctrl`". A
 *  terminal takes a byte stream, so what these tests check is bytes. */

const ESC = String.fromCharCode(27);

function key(id: string) {
  const found = TOUCH_KEYS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no key ${id}`);
  return found;
}

describe("the control byte for a letter", () => {
  it("maps C to 0x03, which is what interrupts a program", () => {
    // The reason the bar exists: a shell you cannot interrupt is a shell you
    // cannot use.
    expect(controlByte("C")).toBe(String.fromCharCode(3));
  });

  it("maps A to 0x01 and Z to 0x1a, the ends of the range", () => {
    expect(controlByte("A")).toBe(String.fromCharCode(1));
    expect(controlByte("Z")).toBe(String.fromCharCode(26));
  });

  it("treats a lower-case letter as the same key", () => {
    expect(controlByte("d")).toBe(controlByte("D"));
  });

  it("has no answer for a digit rather than inventing one", () => {
    expect(controlByte("7")).toBeNull();
  });

  it("has no answer for an empty or multi-character string", () => {
    expect(controlByte("")).toBeNull();
    expect(controlByte("ab")).toBeNull();
  });
});

describe("the key bar", () => {
  it("offers Ctrl, Escape and Tab, which a software keyboard does not have", () => {
    for (const id of ["ctrl", "esc", "tab"]) {
      expect(TOUCH_KEYS.some((k) => k.id === id)).toBe(true);
    }
  });

  it("sends real escape sequences for the arrows", () => {
    expect(key("up").send).toBe(`${ESC}[A`);
    expect(key("down").send).toBe(`${ESC}[B`);
    expect(key("left").send).toBe(`${ESC}[D`);
    expect(key("right").send).toBe(`${ESC}[C`);
  });

  it("puts interrupt on the bar by name, not two taps away", () => {
    expect(key("sigint").send).toBe(String.fromCharCode(3));
  });

  it("gives every key a spoken name, since the labels are glyphs", () => {
    for (const entry of TOUCH_KEYS) {
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it("stays short enough not to eat the terminal it sits under", () => {
    expect(TOUCH_KEYS.length).toBeLessThanOrEqual(10);
  });
});

describe("pressing a key on the bar", () => {
  it("arms Ctrl without sending anything", () => {
    expect(pressTouchKey(key("ctrl"), false)).toEqual({ send: null, ctrlArmed: true });
  });

  it("lets a second tap disarm Ctrl, so a mis-tap is undoable", () => {
    expect(pressTouchKey(key("ctrl"), true)).toEqual({ send: null, ctrlArmed: false });
  });

  it("sends an ordinary key and leaves Ctrl disarmed", () => {
    expect(pressTouchKey(key("tab"), false)).toEqual({ send: "\t", ctrlArmed: false });
  });

  it("disarms Ctrl after a bar key rather than stranding somebody in a mode", () => {
    // Ctrl+Up is not something this bar claims to produce, so the plain
    // sequence goes and the modifier lets go.
    expect(pressTouchKey(key("up"), true)).toEqual({ send: `${ESC}[A`, ctrlArmed: false });
  });
});

describe("typing a character while Ctrl may be armed", () => {
  it("sends the character itself when Ctrl is not armed", () => {
    expect(pressCharacter("d", false)).toEqual({ send: "d", ctrlArmed: false });
  });

  it("turns d into 0x04, which ends the shell", () => {
    expect(pressCharacter("d", true)).toEqual({
      send: String.fromCharCode(4),
      ctrlArmed: false,
    });
  });

  it("turns z into 0x1a, which suspends it", () => {
    expect(pressCharacter("z", true).send).toBe(String.fromCharCode(26));
  });

  it("is one-shot: the modifier lets go after one character", () => {
    // The only behaviour that does not strand somebody in a mode they cannot
    // see.
    expect(pressCharacter("c", true).ctrlArmed).toBe(false);
  });

  it("sends the plain character when Ctrl has no meaning for it", () => {
    // Swallowing the keystroke would look like the terminal had frozen.
    expect(pressCharacter("7", true)).toEqual({ send: "7", ctrlArmed: false });
  });
});
