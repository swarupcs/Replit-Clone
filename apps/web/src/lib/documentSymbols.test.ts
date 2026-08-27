import { describe, expect, it } from "vitest";
import {
  flattenSymbols,
  pathSegments,
  symbolChainAt,
  toFileSymbols,
  type RawSymbol,
} from "./documentSymbols.ts";

const raw: RawSymbol[] = [
  {
    name: "Widget",
    kind: 4,
    range: { startLineNumber: 1, endLineNumber: 40 },
    children: [
      {
        name: "render",
        kind: 5,
        range: { startLineNumber: 5, endLineNumber: 20 },
        children: [
          {
            name: "helper",
            kind: 11,
            range: { startLineNumber: 8, endLineNumber: 12 },
          },
        ],
      },
      {
        name: "dispose",
        kind: 5,
        range: { startLineNumber: 25, endLineNumber: 30 },
      },
    ],
  },
];

describe("toFileSymbols", () => {
  it("keeps the tree and drops what neither consumer needs", () => {
    const [widget] = toFileSymbols(raw);
    expect(widget).toMatchObject({ name: "Widget", kind: 4, startLine: 1, endLine: 40 });
    expect(widget?.children).toHaveLength(2);
  });

  it("copes with a symbol that has no children key at all", () => {
    expect(
      toFileSymbols([{ name: "x", kind: 1, range: { startLineNumber: 1, endLineNumber: 1 } }]),
    ).toEqual([{ name: "x", kind: 1, startLine: 1, endLine: 1, children: [] }]);
  });
});

describe("symbolChainAt", () => {
  const symbols = toFileSymbols(raw);

  it("returns the enclosing chain, outermost first", () => {
    expect(symbolChainAt(symbols, 10).map((symbol) => symbol.name)).toEqual([
      "Widget",
      "render",
      "helper",
    ]);
  });

  /** The innermost enclosing symbol is the one the cursor is in, so a line
   *  inside `render` but outside `helper` stops at `render`. */
  it("stops at the innermost symbol that actually contains the line", () => {
    expect(symbolChainAt(symbols, 18).map((symbol) => symbol.name)).toEqual([
      "Widget",
      "render",
    ]);
  });

  it("returns just the outer symbol between two children", () => {
    expect(symbolChainAt(symbols, 22).map((symbol) => symbol.name)).toEqual(["Widget"]);
  });

  it("returns nothing outside every symbol", () => {
    expect(symbolChainAt(symbols, 100)).toEqual([]);
  });

  it("includes the boundary lines", () => {
    expect(symbolChainAt(symbols, 1)).toHaveLength(1);
    expect(symbolChainAt(symbols, 40)).toHaveLength(1);
  });
});

describe("flattenSymbols", () => {
  it("lists every symbol, however deep", () => {
    expect(flattenSymbols(toFileSymbols(raw)).map((s) => s.name)).toEqual([
      "Widget",
      "render",
      "helper",
      "dispose",
    ]);
  });

  /** Two `render` methods on different classes are different symbols, and a
   *  bare name would make them indistinguishable in a Ctrl+T list. */
  it("qualifies each name with its ancestry", () => {
    const flat = flattenSymbols(toFileSymbols(raw));
    expect(flat.find((s) => s.name === "helper")?.qualified).toBe(
      "Widget › render › helper",
    );
  });

  it("carries the line so a result can be jumped to", () => {
    expect(flattenSymbols(toFileSymbols(raw)).find((s) => s.name === "dispose")?.line)
      .toBe(25);
  });
});

describe("pathSegments", () => {
  it("gives each segment the path that reaches it", () => {
    expect(pathSegments("src/components/Widget.tsx")).toEqual([
      { name: "src", path: "src" },
      { name: "components", path: "src/components" },
      { name: "Widget.tsx", path: "src/components/Widget.tsx" },
    ]);
  });

  it("handles a file at the root", () => {
    expect(pathSegments("README.md")).toEqual([
      { name: "README.md", path: "README.md" },
    ]);
  });

  it("ignores empty segments from a stray slash", () => {
    expect(pathSegments("src//a.ts").map((s) => s.name)).toEqual(["src", "a.ts"]);
  });
});
