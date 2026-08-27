import { describe, expect, it } from "vitest";
import { toMarkerSeverity, toMonacoRange } from "./lspClient.ts";

describe("toMarkerSeverity", () => {
  /** LSP counts 1-4 up from Error; Monaco's MarkerSeverity counts 8,4,2,1
   *  down to Hint. Getting this backwards renders every error as a hint,
   *  which is the kind of bug that looks like "diagnostics do not work". */
  it("maps each LSP severity to its Monaco counterpart", () => {
    expect(toMarkerSeverity(1)).toBe(8);
    expect(toMarkerSeverity(2)).toBe(4);
    expect(toMarkerSeverity(3)).toBe(2);
    expect(toMarkerSeverity(4)).toBe(1);
  });

  it("treats a missing severity as the least severe", () => {
    // The spec allows it, and guessing Error would fill the Problems panel
    // with things the server never called errors.
    expect(toMarkerSeverity(undefined)).toBe(1);
  });

  it("never maps an error down to a hint", () => {
    expect(toMarkerSeverity(1)).toBeGreaterThan(toMarkerSeverity(4));
  });
});

describe("toMonacoRange", () => {
  /** LSP is 0-based, Monaco is 1-based. An off-by-one here puts every
   *  squiggle one line above where the problem is. */
  it("shifts both ends by one", () => {
    expect(
      toMonacoRange({ start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }),
    ).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 6,
    });
  });

  it("handles a range spanning lines", () => {
    expect(
      toMonacoRange({ start: { line: 3, character: 2 }, end: { line: 7, character: 9 } }),
    ).toEqual({
      startLineNumber: 4,
      startColumn: 3,
      endLineNumber: 8,
      endColumn: 10,
    });
  });
});
