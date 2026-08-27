/** A symbol in a file, flattened to what both consumers actually need.
 *
 *  Monaco's own `DocumentSymbol` is a tree with ranges, tags, and a detail
 *  string. Breadcrumbs want the chain enclosing a position; the outline wants
 *  the tree. Both want less than Monaco gives, and neither should import
 *  Monaco's types to say so.
 */
export interface FileSymbol {
  name: string;
  /** Monaco's SymbolKind, passed through so a renderer can pick an icon
   *  without this module knowing what icons exist. */
  kind: number;
  startLine: number;
  endLine: number;
  children: FileSymbol[];
}

/** What Monaco's provider returns, in the shape this module reads it. */
export interface RawSymbol {
  name: string;
  kind: number;
  range: {
    startLineNumber: number;
    endLineNumber: number;
  };
  children?: RawSymbol[];
}

export function toFileSymbols(raw: RawSymbol[]): FileSymbol[] {
  return raw.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.range.startLineNumber,
    endLine: symbol.range.endLineNumber,
    children: toFileSymbols(symbol.children ?? []),
  }));
}

/** The chain of symbols enclosing a line, outermost first.
 *
 *  This is the breadcrumb's second half — the path is the first. Ties are
 *  broken toward the innermost symbol, which is the one the cursor is
 *  actually in.
 */
export function symbolChainAt(symbols: FileSymbol[], line: number): FileSymbol[] {
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    return [symbol, ...symbolChainAt(symbol.children, line)];
  }
  return [];
}

/** Every symbol, depth-first, with its ancestry — for Ctrl+T, which searches
 *  across the file rather than within a scope. */
export function flattenSymbols(
  symbols: FileSymbol[],
  prefix = "",
): { name: string; qualified: string; kind: number; line: number }[] {
  const out: { name: string; qualified: string; kind: number; line: number }[] = [];

  for (const symbol of symbols) {
    const qualified = prefix ? `${prefix} › ${symbol.name}` : symbol.name;
    out.push({
      name: symbol.name,
      qualified,
      kind: symbol.kind,
      line: symbol.startLine,
    });
    out.push(...flattenSymbols(symbol.children, qualified));
  }

  return out;
}

/** The path half of a breadcrumb: each segment with the path that reaches it,
 *  so a segment can be made to do something. */
export function pathSegments(
  relPath: string,
): { name: string; path: string }[] {
  const parts = relPath.split("/").filter(Boolean);
  const segments: { name: string; path: string }[] = [];

  let accumulated = "";
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    segments.push({ name: part, path: accumulated });
  }

  return segments;
}
