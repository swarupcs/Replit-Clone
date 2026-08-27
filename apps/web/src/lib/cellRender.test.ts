import { describe, expect, it } from "vitest";
import { renderCell } from "./cellRender.ts";

describe("renderCell", () => {
  /** The single most common way a data grid lies: showing NULL and an empty
   *  string identically. Telling them apart is most of what the grid is for. */
  it("distinguishes NULL from an empty string", () => {
    expect(renderCell(null)).toEqual({ text: "NULL", kind: "null" });
    expect(renderCell("")).toEqual({ text: "", kind: "text" });
  });

  it("treats undefined as NULL", () => {
    expect(renderCell(undefined).kind).toBe("null");
  });

  it("shows a size for binary rather than the bytes", () => {
    // A megabyte of bytea pasted into a cell helps nobody.
    expect(renderCell("\\x00ff00ff", 17)).toEqual({ text: "4 bytes", kind: "binary" });
    expect(renderCell(new Uint8Array(12))).toEqual({ text: "12 bytes", kind: "binary" });
  });

  it("marks json so it can be expanded rather than read as a string", () => {
    expect(renderCell({ a: 1 }, 3802)).toEqual({ text: '{"a":1}', kind: "json" });
    expect(renderCell('{"a":1}', 114).kind).toBe("json");
  });

  it("keeps a timestamp's offset", () => {
    const at = new Date("2026-08-27T01:02:03.000Z");
    expect(renderCell(at).text).toBe("2026-08-27T01:02:03.000Z");
  });

  it("renders booleans as words rather than as 1 and 0", () => {
    expect(renderCell(true, 16)).toEqual({ text: "true", kind: "boolean" });
    expect(renderCell(false).text).toBe("false");
  });

  it("keeps numbers numeric so they can be aligned right", () => {
    expect(renderCell(42).kind).toBe("number");
    expect(renderCell(0).kind).toBe("number");
  });

  it("does not mistake zero or false for NULL", () => {
    expect(renderCell(0).kind).not.toBe("null");
    expect(renderCell(false).kind).not.toBe("null");
  });

  it("serialises an unexpected object rather than printing [object Object]", () => {
    expect(renderCell({ a: 1 }).text).toBe('{"a":1}');
  });
});
