import { beforeEach, describe, expect, it } from "vitest";
import {
  selectOrderedSelection,
  useTreeSelectionStore,
} from "./treeSelectionStore.ts";

const store = () => useTreeSelectionStore.getState();
const plain = { meta: false, shift: false };
const withMeta = { meta: true, shift: false };
const withShift = { meta: false, shift: true };

const ORDER = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

beforeEach(() => {
  useTreeSelectionStore.setState({
    selected: new Set<string>(),
    anchor: null,
    visibleOrder: [],
  });
  store().setVisibleOrder(ORDER);
});

const selected = () => [...store().selected].sort();

describe("plain click", () => {
  it("selects exactly one row", () => {
    store().click("b.ts", plain);
    expect(selected()).toEqual(["b.ts"]);
  });

  it("replaces the previous selection", () => {
    store().click("b.ts", plain);
    store().click("d.ts", plain);
    expect(selected()).toEqual(["d.ts"]);
  });
});

describe("ctrl or cmd click", () => {
  it("adds to the selection", () => {
    store().click("a.ts", plain);
    store().click("c.ts", withMeta);
    expect(selected()).toEqual(["a.ts", "c.ts"]);
  });

  it("removes a row that was already selected", () => {
    store().click("a.ts", plain);
    store().click("c.ts", withMeta);
    store().click("a.ts", withMeta);
    expect(selected()).toEqual(["c.ts"]);
  });

  it("works from an empty selection", () => {
    store().click("c.ts", withMeta);
    expect(selected()).toEqual(["c.ts"]);
  });
});

describe("shift click", () => {
  it("selects the range downwards", () => {
    store().click("b.ts", plain);
    store().click("d.ts", withShift);
    expect(selected()).toEqual(["b.ts", "c.ts", "d.ts"]);
  });

  it("selects the range upwards", () => {
    store().click("d.ts", plain);
    store().click("b.ts", withShift);
    expect(selected()).toEqual(["b.ts", "c.ts", "d.ts"]);
  });

  it("keeps the anchor, so extending again re-measures from the same place", () => {
    store().click("b.ts", plain);
    store().click("e.ts", withShift);
    store().click("c.ts", withShift);

    // Not b..e then e..c — the anchor stayed at b.
    expect(selected()).toEqual(["b.ts", "c.ts"]);
  });

  it("behaves like a plain click with no anchor", () => {
    store().click("c.ts", withShift);
    expect(selected()).toEqual(["c.ts"]);
  });

  it("selects a single row when the range has no width", () => {
    store().click("c.ts", plain);
    store().click("c.ts", withShift);
    expect(selected()).toEqual(["c.ts"]);
  });

  it("ignores a row that is no longer visible", () => {
    store().click("b.ts", plain);
    store().setVisibleOrder(["a.ts", "b.ts"]);
    store().click("gone.ts", withShift);

    // Falls back to selecting the clicked row rather than producing nonsense.
    expect(selected()).toEqual(["gone.ts"]);
  });
});

describe("ordering", () => {
  it("returns the selection in the order shown on screen", () => {
    store().click("d.ts", plain);
    store().click("a.ts", withMeta);
    store().click("c.ts", withMeta);

    expect(selectOrderedSelection(store())).toEqual(["a.ts", "c.ts", "d.ts"]);
  });

  it("omits rows that have since disappeared", () => {
    store().click("a.ts", plain);
    store().click("e.ts", withMeta);
    store().setVisibleOrder(["a.ts", "b.ts"]);

    expect(selectOrderedSelection(store())).toEqual(["a.ts"]);
  });
});

describe("selectOnly and clear", () => {
  it("collapses to one row", () => {
    store().click("a.ts", plain);
    store().click("b.ts", withMeta);
    store().selectOnly("e.ts");

    expect(selected()).toEqual(["e.ts"]);
  });

  it("empties the selection", () => {
    store().click("a.ts", plain);
    store().clear();

    expect(selected()).toEqual([]);
    expect(store().anchor).toBeNull();
  });
});
