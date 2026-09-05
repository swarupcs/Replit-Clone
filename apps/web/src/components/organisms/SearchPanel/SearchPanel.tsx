import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Spin, Tooltip } from "antd";
import { useNavigate } from "react-router-dom";
import {
  VscCaseSensitive,
  VscLibrary,
  VscRegex,
  VscReplaceAll,
  VscWholeWord,
} from "react-icons/vsc";
import type { CrossProjectSearchResult, SearchMatch } from "@replit-clone/shared";
import { fileExtension } from "@replit-clone/shared";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore, selectCanEdit } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore } from "../../../store/openTabsStore.ts";
import { searchAllProjectsApi } from "../../../apis/projects.ts";

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
  const navigate = useNavigate();
  const editorSocket = useEditorSocketStore((state) => state.editorSocket);
  const canEdit = useEditorSocketStore(selectCanEdit);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [replacement, setReplacement] = useState("");
  /** Search this project, or every project the account owns. Off by default:
   *  the common search is the one about the code in front of you, and a
   *  default that walked twenty-five trees would make the common case slow to
   *  answer a question nobody asked. */
  const [allProjects, setAllProjects] = useState(false);
  const [across, setAcross] = useState<CrossProjectSearchResult | null>(null);

  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** "Replaced N in M files", shown until the next search changes anything. */
  const [summary, setSummary] = useState<string | null>(null);

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

    const onReplaced = (payload: {
      replacements: number;
      files: unknown[];
      truncated: boolean;
    }) => {
      setSummary(
        `Replaced ${String(payload.replacements)} in ${String(payload.files.length)} file` +
          (payload.files.length === 1 ? "" : "s") +
          (payload.truncated ? " · partial, run it again" : ""),
      );
      // The results on screen are stale now; re-run the search against the
      // rewritten files.
      setSearching(true);
      editorSocket.emit("search", {
        query: pendingQuery.current,
        caseSensitive,
        wholeWord,
        isRegex,
      });
    };

    editorSocket.on("searchResults", onResults);
    editorSocket.on("replaceResult", onReplaced);
    editorSocket.on("error", onError);

    return () => {
      editorSocket.off("searchResults", onResults);
      editorSocket.off("replaceResult", onReplaced);
      editorSocket.off("error", onError);
    };
    // The toggles feed the follow-up search a replace triggers.
  }, [editorSocket, caseSensitive, wholeWord, isRegex]);

  useEffect(() => {
    const trimmed = query.trim();
    pendingQuery.current = trimmed;
    setSummary(null);

    // The socket is bound to one project, so the wider search cannot use it —
    // but the narrow one still should, because it is already there and already
    // has the file tree warm.
    if (!trimmed || (!editorSocket && !allProjects)) {
      setMatches([]);
      setAcross(null);
      setTruncated(false);
      setSearching(false);
      setError(null);
      return;
    }

    setSearching(true);
    let abandoned = false;

    const timer = setTimeout(() => {
      if (!allProjects) {
        editorSocket?.emit("search", {
          query: trimmed,
          caseSensitive,
          wholeWord,
          isRegex,
        });
        return;
      }

      void searchAllProjectsApi({ query: trimmed, caseSensitive, wholeWord, isRegex })
        .then((result) => {
          // The same guard the socket path gets from `pendingQuery`: a slow
          // reply for an old query must not overwrite a newer one's results.
          if (abandoned) return;
          setAcross(result);
          setSearching(false);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (abandoned) return;
          setSearching(false);
          setError(
            reason instanceof Error ? reason.message : "That search failed",
          );
        });
    }, DEBOUNCE_MS);

    return () => {
      abandoned = true;
      clearTimeout(timer);
    };
  }, [query, caseSensitive, wholeWord, isRegex, editorSocket, allProjects]);

  const groups = useMemo(() => groupByFile(matches), [matches]);

  function openMatch(match: SearchMatch) {
    // Opening is asynchronous — the contents come over the socket — so the
    // position is left for the editor to pick up once the file arrives.
    useOpenTabsStore
      .getState()
      .requestReveal(match.relPath, match.line, match.column);
    editorSocket?.emit("readFile", { relPath: match.relPath });
  }

  /** A result in a project that is not this one.
   *
   *  The reveal is requested BEFORE navigating and survives it, because the
   *  tab store outlives the route. The socket does not, so the read is left to
   *  the destination — see ProjectPlayground, which opens whatever a pending
   *  reveal names once it has a socket of its own.
   */
  function openElsewhere(projectId: string, match: SearchMatch) {
    useOpenTabsStore
      .getState()
      .requestReveal(match.relPath, match.line, match.column);
    void navigate(`/project/${projectId}`);
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
    {
      key: "all",
      title: "Search every project you own",
      icon: <VscLibrary size={14} />,
      on: allProjects,
      toggle: () => setAllProjects((value) => !value),
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

      {canEdit && (
        <div style={{ padding: "0 10px 8px", display: "flex", gap: 4 }}>
          <Input
            size="small"
            allowClear
            placeholder="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            style={{ fontSize: 12 }}
          />
          <Tooltip title="Replace every match in the project">
            <Button
              size="small"
              type="text"
              className="rc-icon-button"
              aria-label="Replace all"
              disabled={!query.trim() || !matches.length}
              onClick={() =>
                editorSocket?.emit("replaceInProject", {
                  search: {
                    query: query.trim(),
                    caseSensitive,
                    wholeWord,
                    isRegex,
                  },
                  replacement,
                })
              }
            >
              <VscReplaceAll size={14} />
            </Button>
          </Tooltip>
        </div>
      )}

      {summary && (
        <div
          style={{
            padding: "0 14px 6px",
            fontSize: 11.5,
            color: "var(--rc-text-subtle)",
          }}
        >
          {summary}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 12 }}>
        {error ? (
          <div style={{ padding: "16px 14px", fontSize: 12, color: "var(--rc-red)" }}>
            {error}
          </div>
        ) : searching ? (
          <div style={{ display: "grid", placeItems: "center", padding: 24 }}>
            <Spin size="small" />
          </div>
        ) : allProjects ? (
          <CrossProjectResults
            result={across}
            query={query.trim()}
            onOpen={openElsewhere}
          />
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
                  // A real button rather than a div with a click handler: a
                  // result you cannot reach without a mouse is not a result.
                  <button
                    key={`${match.relPath}:${String(match.line)}:${String(match.column)}`}
                    type="button"
                    className="rc-tree-row rc-row-button"
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
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

/** Results from every project, grouped by the project they came from.
 *
 *  Deliberately a flat list of matches under each project rather than the
 *  file-grouped tree the single-project view uses. The question this search
 *  answers is "which project", so the project is the heading that matters, and
 *  a second level of nesting inside a 300px sidebar buys folding at the cost
 *  of ever seeing more than two results.
 */
function CrossProjectResults({
  result,
  query,
  onOpen,
}: {
  result: CrossProjectSearchResult | null;
  query: string;
  onOpen: (projectId: string, match: SearchMatch) => void;
}) {
  if (!query || !result) return null;

  const found = result.projects.reduce(
    (total, project) => total + project.matches.length,
    0,
  );

  if (found === 0) {
    return (
      <div
        style={{
          padding: "20px 14px",
          fontSize: 12,
          color: "var(--rc-text-subtle)",
          textAlign: "center",
        }}
      >
        No results for “{query}” in any of your projects
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          padding: "4px 14px 8px",
          fontSize: 11.5,
          color: "var(--rc-text-subtle)",
        }}
      >
        {found} result{found === 1 ? "" : "s"} in {result.projects.length}{" "}
        project{result.projects.length === 1 ? "" : "s"}
        {/* Said plainly. A search that stopped early and did not say so makes
            a missing result look like proof the text is nowhere. */}
        {result.truncated &&
          ` · searched ${String(result.scanned)} of ${String(result.total)}`}
      </div>

      {result.projects.map((project) => (
        <div key={project.projectId} style={{ marginBottom: 6 }}>
          <div
            className="rc-tree-row"
            style={{ paddingLeft: 12, cursor: "default" }}
            title={project.name}
          >
            <VscLibrary size={13} style={{ color: "var(--rc-text-subtle)" }} />
            <span style={{ fontWeight: 500 }}>{project.name}</span>
            <span
              style={{
                marginLeft: "auto",
                marginRight: 10,
                fontSize: 11,
                color: "var(--rc-text-subtle)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {project.matches.length}
              {project.truncated && "+"}
            </span>
          </div>

          {project.matches.map((match) => (
            <button
              key={`${match.relPath}:${String(match.line)}:${String(match.column)}`}
              type="button"
              className="rc-tree-row rc-row-button"
              style={{ paddingLeft: 28 }}
              onClick={() => onOpen(project.projectId, match)}
              title={`${project.name} — ${match.relPath}:${String(match.line)}`}
            >
              <span
                style={{
                  color: "var(--rc-text-subtle)",
                  fontFamily: "var(--rc-mono)",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "45%",
                }}
              >
                {match.relPath}:{match.line}
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
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
