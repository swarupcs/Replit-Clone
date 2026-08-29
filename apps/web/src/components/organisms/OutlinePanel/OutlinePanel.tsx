import { Empty } from "antd";
import {
  VscSymbolClass,
  VscSymbolField,
  VscSymbolInterface,
  VscSymbolMethod,
  VscSymbolVariable,
} from "react-icons/vsc";
import { useSymbolStore } from "../../../store/symbolStore.ts";
import { useOpenTabsStore, selectActiveTab } from "../../../store/openTabsStore.ts";
import type { FileSymbol } from "../../../lib/documentSymbols.ts";

/** Monaco SymbolKind -> glyph. Only the kinds worth telling apart; the name
 *  carries the meaning and the icon only helps someone scan. */
const ICONS: Record<number, typeof VscSymbolClass> = {
  4: VscSymbolClass,
  10: VscSymbolInterface,
  5: VscSymbolMethod,
  11: VscSymbolMethod,
  6: VscSymbolField,
  9: VscSymbolInterface,
};

const Row = ({
  symbol,
  depth,
  onPick,
}: {
  symbol: FileSymbol;
  depth: number;
  onPick: (line: number) => void;
}) => {
  const Icon = ICONS[symbol.kind] ?? VscSymbolVariable;

  return (
    <>
      <button
        type="button"
        className="rc-outline-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onPick(symbol.startLine)}
      >
        <Icon size={12} />
        <span>{symbol.name}</span>
      </button>
      {symbol.children.map((child) => (
        <Row
          key={`${child.name}:${child.startLine}`}
          symbol={child}
          depth={depth + 1}
          onPick={onPick}
        />
      ))}
    </>
  );
};

/** The file's symbols as a tree.
 *
 *  Reads the same store the breadcrumbs do, rather than fetching its own
 *  copy — one provider behind both, because two would be able to disagree
 *  about the same file.
 */
export const OutlinePanel = () => {
  const symbols = useSymbolStore((state) => state.symbols);
  const symbolPath = useSymbolStore((state) => state.relPath);
  const activeTab = useOpenTabsStore(selectActiveTab);
  const requestReveal = useOpenTabsStore((state) => state.requestReveal);

  if (!activeTab) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="No file is open." />
      </div>
    );
  }

  if (symbolPath !== activeTab.relPath || symbols.length === 0) {
    return (
      <div style={{ padding: 16, color: "var(--rc-text-subtle)", fontSize: 12 }}>
        No symbols for this file. TypeScript and JavaScript have them today;
        other languages get them when a language server is available.
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", height: "100%", padding: "6px 0" }}>
      {symbols.map((symbol) => (
        <Row
          key={`${symbol.name}:${symbol.startLine}`}
          symbol={symbol}
          depth={0}
          onPick={(line) => requestReveal(activeTab.relPath, line, 1)}
        />
      ))}
    </div>
  );
};
