import { useMemo, useState } from "react";
import { Modal, Input } from "antd";
import { useSymbolStore } from "../../../store/symbolStore.ts";
import { useOpenTabsStore, selectActiveTab } from "../../../store/openTabsStore.ts";
import { flattenSymbols } from "../../../lib/documentSymbols.ts";
import { fuzzyScore } from "../../../utils/fuzzyScore.ts";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Go to symbol in the open file.
 *
 *  The file-scoped half of "go to symbol in workspace". A workspace symbol
 *  index is a different feature — it needs every file parsed and kept
 *  current, which is what a language server is for — and Quick Open already
 *  answers "which file". Naming the narrower thing is better than shipping
 *  something that silently only searches one file while claiming the
 *  workspace.
 */
export const SymbolSearch = ({ open, onClose }: Props) => {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const symbols = useSymbolStore((state) => state.symbols);
  const activeTab = useOpenTabsStore(selectActiveTab);
  const requestReveal = useOpenTabsStore((state) => state.requestReveal);

  const results = useMemo(() => {
    const flat = flattenSymbols(symbols);
    if (!query.trim()) return flat.slice(0, 50);

    return flat
      // fuzzyScore takes (candidate, query) and returns null for no match.
      .map((symbol) => ({ symbol, score: fuzzyScore(symbol.name, query) }))
      .filter((entry): entry is { symbol: typeof entry.symbol; score: number } =>
        entry.score !== null,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((entry) => entry.symbol);
  }, [symbols, query]);

  const pick = (index: number) => {
    const symbol = results[index];
    if (!symbol || !activeTab) return;
    requestReveal(activeTab.relPath, symbol.line, 1);
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      destroyOnHidden
      styles={{ body: { padding: 0 } }}
    >
      <Input
        autoFocus
        placeholder="Go to symbol in this file…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlighted(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlighted((index) => Math.min(index + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlighted((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            pick(highlighted);
          }
        }}
        style={{ margin: 12, width: "calc(100% - 24px)" }}
      />

      <div style={{ maxHeight: 320, overflow: "auto" }}>
        {results.length === 0 && (
          <div style={{ padding: 16, color: "var(--rc-text-subtle)", fontSize: 13 }}>
            {symbols.length === 0
              ? "No symbols for this file."
              : "Nothing matches."}
          </div>
        )}

        {results.map((symbol, index) => (
          <button
            key={`${symbol.qualified}:${symbol.line}`}
            type="button"
            className="rc-outline-row"
            data-active={index === highlighted}
            style={{ width: "100%" }}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => pick(index)}
          >
            <span>{symbol.name}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: "var(--rc-text-subtle)",
              }}
            >
              {symbol.qualified}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
};
