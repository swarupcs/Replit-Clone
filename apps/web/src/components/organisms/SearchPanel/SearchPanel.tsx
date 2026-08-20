import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Spin, Tooltip } from "antd";
import { VscCaseSensitive, VscRegex, VscWholeWord } from "react-icons/vsc";
import type { SearchMatch } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";

/** Wait after the last keystroke before searching. Long enough that typing a
 *  word does not scan the tree once per character. */
const DEBOUNCE_MS = 300;

interface FileGroup {
  relPath: string;
  name: string;
  matches: SearchMatch[];
}

/** Groups matches by file, the way every editor's search results read. */
function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();

  for (const match of matches) {
    const existing = groups.get(match.relPath);
    if (existing) {
      existing.matches.push(match);
      continue;
    }

    groups.set(match.relPath, {
      relPath: match.relPath,
      name: match.relPath.split("/").pop() ?? match.relPath,
      matches: [match],
    });
  }

  return [...groups.values()];
}

/** Full-text search across the project.
 *
 *  Quick Open matches filenames only, so finding a symbol meant opening files
 *  and reading them. This is the other half.
 */
export const SearchPanel = () => {
  const { editorSocket } = useEditorSocketStore();

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);

  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The query the displayed results belong to, so a slow reply for an old
   *  query cannot overwrite the results for a newer one. */
  const pendingQuery = useRef("");

  useEffect(() => {
    if (!editorSocket) return;

    const onResults = (payload: {
      query: string;
      matches: SearchMatch[];
      truncated: boolean;
    }) => {
      if (payload.query !== pendingQuery.current) return;

      setMatches(payload.matches);
      setTruncated(payload.truncated);
      setSearching(false);
      setError(null);
    };

    const onError = (payload: { message: string }) => {
      // A regex the user is halfway through typing fails to compile; saying so
      // is more useful than showing nothing and letting them wonder.
      setSearching(false);
      setError(payload.message);
    };

    editorSocket.on("searchResults", onResults);
    editorSocket.on("error", onError);

    return () => {
      editorSocket.off("searchResults", onResults);
      editorSocket.off("error", onError);
    };
  }, [editorSocket]);

  useEffect(() => {
    const trimmed = query.trim();
    pendingQuery.current = trimmed;

    if (!trimmed || !editorSocket) {
      setMatches([]);
      setTruncated(false);
      setSearching(false);
      setError(null);
      return;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      editorSocket.emit("search", {
        query: trimmed,
        caseSensitive,
        wholeWord,
        isRegex,
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, caseSensitive, wholeWord, isRegex, editorSocket]);

  const groups = useMemo(() => groupByFile(matches), [matches]);

  function openMatch(match: SearchMatch) {
    // Opening is asynchronous — the contents come over the socket — so the
    // position is left for the editor to pick up once the file arrives.
    useOpenTabsStore
      .getState()
      .requestReveal(match.relPath, match.line, match.column);
    editorSocket?.emit("readFile", { relPath: match.relPath });
  }

  const toggles: {
    key: string;
    title: string;
    icon: React.ReactNode;
    on: boolean;
    toggle: () => void;
  }[] = [
    {
      key: "case",
      title: "Match case",
      icon: <VscCaseSensitive size={14} />,
      on: caseSensitive,
      toggle: () => setCaseSensitive((value) => !value),
    },
    {
      key: "word",
      title: "Match whole word",
      icon: <VscWholeWord size={14} />,
      on: wholeWord,
      toggle: () => setWholeWord((value) => !value),
    },
    {
      key: "regex",
      title: "Use a regular expression",
      icon: <VscRegex size={14} />,
      on: isRegex,
      toggle: () => setIsRegex((value) => !value),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="rc-pane-label">
        <span>Search</span>
      </div>

      <div style={{ padding: "2px 10px 8px", display: "flex", gap: 4 }}>
        <Input
          size="small"
          allowClear
          autoFocus
          placeholder="Search in files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ fontSize: 12 }}
        />

        {toggles.map((toggle) => (
          <Tooltip key={toggle.key} title={toggle.title}>
            <button
              className="rc-icon-button"
              data-on={toggle.on}
              aria-label={toggle.title}
              aria-pressed={toggle.on}
              onClick={toggle.toggle}
            >
              {toggle.icon}
            </button>
          </Tooltip>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 12 }}>
        {error ? (
          <div style={{ padding: "16px 14px", fontSize: 12, color: "var(--rc-red)" }}>
            {error}
          </div>
        ) : searching ? (
          <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : query.trim() && groups.length === 0 ? (
          <div
            style={{
              padding: "20px 14px",
              fontSize: 12,
              color: "var(--rc-text-subtle)",
              textAlign: "center",
            }}
          >
            No results for “{query.trim()}”
          </div>
        ) : (
          <>
            {groups.length > 0 && (
              <div
                style={{
                  padding: "4px 14px 8px",
                  fontSize: 11.5,
                  color: "var(--rc-text-subtle)",
                }}
              >
                {matches.length} result{matches.length === 1 ? "" : "s"} in{" "}
                {groups.length} file{groups.length === 1 ? "" : "s"}
                {/* Said plainly, so a partial list is never mistaken for a
                    complete one. */}
                {truncated && " · showing the first matches only"}
              </div>
            )}

            {groups.map((group) => (
              <div key={group.relPath} style={{ marginBottom: 6 }}>
                <div
                  className="rc-tree-row"
                  style={{ paddingLeft: 12, cursor: "default" }}
                  title={group.relPath}
                >
                  <FileIcon extension={fileExtension(group.name)} name={group.name} />
                  <span style={{ fontWeight: 500 }}>{group.name}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      marginRight: 10,
                      fontSize: 11,
                      color: "var(--rc-text-subtle)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {group.matches.length}
                  </span>
                </div>

                {group.matches.map((match) => (
                  <div
                    key={`${match.relPath}:${String(match.line)}:${String(match.column)}`}
                    className="rc-tree-row"
                    style={{ paddingLeft: 32 }}
                    onClick={() => openMatch(match)}
                    title={`${match.relPath}:${String(match.line)}`}
                  >
                    <span
                      style={{
                        color: "var(--rc-text-subtle)",
                        fontFamily: "var(--rc-mono)",
                        fontSize: 11,
                        minWidth: 30,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {match.line}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--rc-mono)",
                        fontSize: 11.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {match.preview.trim()}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};
