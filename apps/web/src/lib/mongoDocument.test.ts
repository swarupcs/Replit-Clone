import { describe, expect, it } from "vitest";
import { presenceLabel, renderValue, summariseDocument } from "./mongoDocument.ts";

describe("renderValue", () => {
  it("unwraps an ObjectId rather than showing the EJSON wrapper", () => {
    // Every document has an `_id`. Rendering it as {"$oid":"651f…"} would put
    // the noisiest possible value in the first column of every row.
    expect(renderValue({ $oid: "651f1f77bcf86cd799439011" })).toEqual({
      text: "651f1f77bcf86cd799439011",
      kind: "objectid",
    });
  });

  it("renders a relaxed $date as its ISO instant, offset kept", () => {
    expect(renderValue({ $date: "2026-08-27T10:00:00Z" })).toEqual({
      text: "2026-08-27T10:00:00Z",
      kind: "date",
    });
  });

  it("renders a canonical $date, where the inner value is a $numberLong", () => {
    expect(renderValue({ $date: { $numberLong: "0" } })).toEqual({
      text: "1970-01-01T00:00:00.000Z",
      kind: "date",
    });
  });

  it("keeps a Decimal128 exact rather than turning it into a float", () => {
    // The whole reason $numberDecimal exists. Number("…") would lose it.
    expect(renderValue({ $numberDecimal: "9.99" })).toEqual({
      text: "9.99",
      kind: "number",
    });
  });

  it("summarises an array by length rather than dumping it", () => {
    expect(renderValue([1, 2, 3])).toEqual({ text: "[3 items]", kind: "array" });
    expect(renderValue([1]).text).toBe("[1 item]");
  });

  it("summarises a nested object by field count", () => {
    expect(renderValue({ city: "a", zip: "b" })).toEqual({
      text: "{2 fields}",
      kind: "object",
    });
  });

  it("leaves a $binary wrapped rather than showing a wall of base64", () => {
    const rendered = renderValue({ $binary: { base64: "AAAA", subType: "00" } });
    expect(rendered.kind).toBe("object");
  });

  it("does not mistake a real field named like a wrapper for a wrapper", () => {
    // A two-key object is a document, whatever its first key is called.
    expect(renderValue({ $oid: "x", note: "y" }).kind).toBe("object");
  });

  it.each([
    [null, "null"],
    [undefined, "null"],
    [true, "boolean"],
    [3, "number"],
    ["text", "text"],
  ])("renders %s", (value, kind) => {
    expect(renderValue(value).kind).toBe(kind);
  });
});

describe("summariseDocument", () => {
  it("shows the first few fields and says how many are left", () => {
    expect(
      summariseDocument({ _id: { $oid: "abc" }, a: 1, b: 2, c: 3, d: 4 }),
    ).toBe("_id: abc, a: 1, b: 2, +2 more");
  });

  it("does not claim more fields when there are none left", () => {
    expect(summariseDocument({ a: 1 })).toBe("a: 1");
  });

  it("handles an empty document", () => {
    expect(summariseDocument({})).toBe("");
  });
});

describe("presenceLabel", () => {
  it("says 'every' rather than '100%' when a field is always there", () => {
    expect(presenceLabel(1)).toBe("in every sampled document");
  });

  it("gives a percentage a person can act on", () => {
    expect(presenceLabel(0.25)).toBe("in 25% of the sample");
  });
});
