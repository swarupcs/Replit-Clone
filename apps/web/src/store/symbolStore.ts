import { create } from "zustand";
import type { FileSymbol } from "../lib/documentSymbols.ts";

/** Symbols for the file on screen.
 *
 *  One provider feeds both the breadcrumbs and the outline. §2.2 asks for
 *  that explicitly — two fetches of the same document symbols would be twice
 *  the work for a thing that can disagree with itself between panes.
 */
interface SymbolStore {
  relPath: string | null;
  symbols: FileSymbol[];
  /** Where the cursor is, so the breadcrumb can say which symbol encloses it
   *  without every keystroke re-deriving the whole tree. */
  line: number;
  setSymbols: (relPath: string, symbols: FileSymbol[]) => void;
  setLine: (line: number) => void;
  clear: () => void;
}

export const useSymbolStore = create<SymbolStore>((set) => ({
  relPath: null,
  symbols: [],
  line: 1,
  setSymbols: (relPath, symbols) => set({ relPath, symbols }),
  setLine: (line) => set({ line }),
  clear: () => set({ relPath: null, symbols: [], line: 1 }),
}));
