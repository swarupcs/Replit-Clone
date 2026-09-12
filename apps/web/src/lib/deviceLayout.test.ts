import { describe, expect, it } from "vitest";
import {
  COARSE_POINTER_QUERY,
  NARROW_QUERY,
  hitTargetPx,
  layoutWidth,
  touchEditorOptions,
  wantsTerminalKeys,
} from "./deviceLayout.ts";

/** The point of §13.10's layer: width and pointer are different questions, and
 *  the existing single breakpoint answers only one of them. */

const tablet = { narrow: false, coarsePointer: true };
const narrowDesktop = { narrow: true, coarsePointer: false };
const phone = { narrow: true, coarsePointer: true };
const desktop = { narrow: false, coarsePointer: false };

describe("layout still keys off width", () => {
  it("is narrow when the viewport is, whatever is holding it", () => {
    expect(layoutWidth(narrowDesktop)).toBe("narrow");
    expect(layoutWidth(phone)).toBe("narrow");
  });

  it("is wide on a tablet, which has room for the panes", () => {
    expect(layoutWidth(tablet)).toBe("wide");
  });
});

describe("touch affordances key off the POINTER, not the width", () => {
  it("offers the terminal key bar on a wide tablet", () => {
    // 1024px and no keyboard: wide enough for the panes, still no Ctrl.
    expect(wantsTerminalKeys(tablet)).toBe(true);
  });

  it("does NOT offer it in a narrow desktop window", () => {
    // A real keyboard with a real Ctrl on it. A bar of fake modifiers there is
    // clutter in front of a terminal.
    expect(wantsTerminalKeys(narrowDesktop)).toBe(false);
  });

  it("offers it on a phone", () => {
    expect(wantsTerminalKeys(phone)).toBe(true);
  });

  it("does not offer it on a desktop", () => {
    expect(wantsTerminalKeys(desktop)).toBe(false);
  });
});

describe("hit targets", () => {
  it("are finger-sized for a coarse pointer", () => {
    // A fingertip covers about 9mm and lands approximately.
    expect(hitTargetPx(tablet)).toBe(44);
  });

  it("stay mouse-sized in a narrow desktop window", () => {
    expect(hitTargetPx(narrowDesktop)).toBe(24);
  });
});

describe("the editor's touch options", () => {
  it("says nothing at all for a mouse", () => {
    // Null rather than a no-op object, so a mouse user's own settings are not
    // overwritten with identical values.
    expect(touchEditorOptions(desktop, 14)).toBeNull();
    expect(touchEditorOptions(narrowDesktop, 14)).toBeNull();
  });

  it("turns off the hover popup, which on touch covers the tapped line", () => {
    expect(touchEditorOptions(phone, 14)?.hover.enabled).toBe(false);
  });

  it("turns off the minimap, which is a mouse's scrollbar", () => {
    expect(touchEditorOptions(phone, 14)?.minimap.enabled).toBe(false);
  });

  it("nudges the font up rather than redesigning it", () => {
    expect(touchEditorOptions(phone, 14)?.fontSize).toBe(15);
  });

  it("leaves a larger chosen size alone, because it was chosen", () => {
    expect(touchEditorOptions(phone, 20)?.fontSize).toBe(20);
  });
});

describe("the queries themselves", () => {
  it("keeps the existing breakpoint unchanged", () => {
    // §13.10 adds a question; it does not move the answer to the old one.
    expect(NARROW_QUERY).toBe("(max-width: 900px)");
  });

  it("asks about the pointer, which is a capability rather than a guess", () => {
    expect(COARSE_POINTER_QUERY).toBe("(pointer: coarse)");
  });
});
