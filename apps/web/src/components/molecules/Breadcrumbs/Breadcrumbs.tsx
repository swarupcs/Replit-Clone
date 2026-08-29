import { useOpenTabsStore, selectActiveTab } from "../../../store/openTabsStore.ts";
import { useSymbolStore } from "../../../store/symbolStore.ts";
import { pathSegments, symbolChainAt } from "../../../lib/documentSymbols.ts";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";

/** The path-plus-symbol bar under the tab strip.
 *
 *  The symbol half only appears for languages that have a symbol provider —
 *  TypeScript and JavaScript today; anything else needs a language server to
 *  supply them. It degrades to just the path rather than to an empty bar,
 *  because a file's location is worth showing on its own.
 */
export const Breadcrumbs = () => {
  const activeTab = useOpenTabsStore(selectActiveTab);
  const symbols = useSymbolStore((state) => state.symbols);
  const symbolPath = useSymbolStore((state) => state.relPath);
  const line = useSymbolStore((state) => state.line);
  const requestReveal = useOpenTabsStore((state) => state.requestReveal);

  if (!activeTab) return null;

  const segments = pathSegments(activeTab.relPath);
  // Symbols belong to whichever file they were last read from; showing them
  // over a different file would be worse than showing none.
  const chain =
    symbolPath === activeTab.relPath ? symbolChainAt(symbols, line) : [];

  return (
    <nav className="rc-breadcrumbs" aria-label="Breadcrumbs">
      {segments.map((segment, index) => (
        <span key={segment.path} className="rc-breadcrumb">
          {index === segments.length - 1 && (
            <FileIcon extension={activeTab.extension} name={activeTab.name} />
          )}
          <span>{segment.name}</span>
          {index < segments.length - 1 && (
            <span className="rc-breadcrumb-sep" aria-hidden>
              ›
            </span>
          )}
        </span>
      ))}

      {chain.map((symbol) => (
        <span key={`${symbol.name}:${symbol.startLine}`} className="rc-breadcrumb">
          <span className="rc-breadcrumb-sep" aria-hidden>
            ›
          </span>
          <button
            type="button"
            className="rc-breadcrumb-symbol"
            onClick={() => requestReveal(activeTab.relPath, symbol.startLine, 1)}
          >
            {symbol.name}
          </button>
        </span>
      ))}
    </nav>
  );
};
