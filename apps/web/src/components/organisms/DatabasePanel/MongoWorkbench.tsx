import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Segmented, Spin, Tooltip, message } from "antd";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import {
  VscChevronDown,
  VscChevronRight,
  VscDatabase,
  VscJson,
  VscListTree,
  VscPlay,
  VscRefresh,
  VscTable,
  VscTrash,
} from "react-icons/vsc";
import {
  getMongoCollectionSchemaApi,
  getMongoCollectionsApi,
  runMongoQueryApi,
  type CollectionSchema,
  type MongoCollection,
  type MongoQueryResult,
} from "../../../apis/projects.ts";
import { presenceLabel, renderValue, summariseDocument } from "../../../lib/mongoDocument.ts";
import { useThemeMode } from "../../../hooks/useThemeMode.ts";

const PAGE_SIZE = 50;

interface Props {
  projectId: string;
  label: string;
  isOwner: boolean;
  onDisconnect: () => void;
}

function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? "Something went wrong.";
}

/** One document, collapsed to a summary line until it is opened.
 *
 *  §7.6 calls this the *primary* view for MongoDB rather than a secondary
 *  one, and the reason is structural: a document nests, and a grid can only
 *  show the top level. A grid of `address: {4 fields}` is a grid that has
 *  hidden the answer.
 */
const DocumentCard = ({ document, index }: { document: unknown; index: number }) => {
  const [open, setOpen] = useState(index === 0);

  return (
    <div className="rc-mongo-doc">
      <button
        className="rc-mongo-doc-head"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        {open ? <VscChevronDown size={12} /> : <VscChevronRight size={12} />}
        <span className="rc-mongo-doc-index">{index + 1}</span>
        <span className="rc-mongo-doc-summary">{summariseDocument(document)}</span>
      </button>

      {open && (
        <pre className="rc-mongo-doc-body">{JSON.stringify(document, null, 2)}</pre>
      )}
    </div>
  );
};

/** The flattened view, offered second.
 *
 *  Useful when the documents really are flat and there are many of them,
 *  which is common enough to be worth a toggle and not common enough to be
 *  the default. */
const DocumentGrid = ({ result }: { result: MongoQueryResult }) => (
  <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
    <table className="rc-result-grid">
      <thead>
        <tr>
          {result.fields.map((field) => (
            <th key={field}>{field}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.documents.map((document, rowIndex) => (
          <tr key={rowIndex}>
            {result.fields.map((field) => {
              const cell = renderValue(
                (document as Record<string, unknown> | null)?.[field],
              );
              return (
                <td key={field} data-kind={cell.kind}>
                  {cell.text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Collection tree, filter/pipeline editor and document view.
 *
 *  Deliberately not the SQL workbench with different words on the buttons.
 *  The input is an EJSON filter document or an aggregation pipeline against
 *  a chosen collection, the schema is sampled rather than declared, and the
 *  result is a list of documents — §7.6 is explicit that papering over those
 *  differences produces something wrong about both databases.
 */
export const MongoWorkbench = ({ projectId, label, isOwner, onDisconnect }: Props) => {
  const [collections, setCollections] = useState<MongoCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<MongoCollection | null>(null);
  const [schemas, setSchemas] = useState<Record<string, CollectionSchema>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"find" | "aggregate">("find");
  const [text, setText] = useState("{}");
  const [result, setResult] = useState<MongoQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [skip, setSkip] = useState(0);
  const [view, setView] = useState<"documents" | "table">("documents");

  const monacoTheme = useThemeMode() === "light" ? "alucard" : "dracula";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const listed = await getMongoCollectionsApi(projectId);
      setCollections(listed);
      setActive((previous) => previous ?? listed[0] ?? null);
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyOf = (entry: MongoCollection) => `${entry.database}.${entry.name}`;

  const toggle = async (entry: MongoCollection) => {
    const key = keyOf(entry);
    const isOpen = expanded.has(key);

    setExpanded((previous) => {
      const next = new Set(previous);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });

    // Sampled on expand rather than for every collection up front: there is
    // no Mongo equivalent of one introspection query, so eager inference
    // would be a `$sample` per collection every time the panel opens.
    if (!isOpen && !schemas[key]) {
      try {
        const schema = await getMongoCollectionSchemaApi(
          projectId,
          entry.database,
          entry.name,
        );
        setSchemas((previous) => ({ ...previous, [key]: schema }));
      } catch (error) {
        void message.error(errorMessage(error));
      }
    }
  };

  const run = useCallback(
    async (from = 0) => {
      if (!active) return;
      setRunning(true);
      try {
        setResult(
          await runMongoQueryApi(projectId, {
            database: active.database,
            collection: active.name,
            mode,
            text,
            limit: PAGE_SIZE,
            skip: from,
          }),
        );
        setSkip(from);
      } catch (error) {
        void message.error(errorMessage(error));
      } finally {
        setRunning(false);
      }
    },
    [projectId, active, mode, text],
  );

  /** Kept in a ref because the Monaco command is registered once on mount and
   *  would otherwise close over the first `run` forever — the filter text it
   *  ran would be whatever was in the box when the editor mounted. */
  const runRef = useRef(run);
  runRef.current = run;

  const handleMount = (editor: unknown, monaco: Monaco) => {
    (editor as { addCommand: (key: number, handler: () => void) => void }).addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => void runRef.current(0),
    );
  };

  const onModeChange = (next: "find" | "aggregate") => {
    setMode(next);
    // The two inputs are different shapes, so a leftover `{}` in the pipeline
    // box would be an error rather than an empty query. Only the untouched
    // default is replaced; anything the user typed is left alone.
    setText((previous) => {
      if (next === "aggregate" && previous.trim() === "{}") return "[\n  \n]";
      if (next === "find" && previous.trim().replace(/\s+/g, "") === "[]") return "{}";
      return previous;
    });
  };

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <Spin />
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="rc-db-header">
        <VscDatabase size={13} />
        <span style={{ fontSize: 12, color: "var(--rc-text-muted)" }}>{label}</span>
        <span className="rc-db-engine-tag">MongoDB</span>
        <span style={{ flex: 1 }} />
        <Tooltip title="Reload the collections">
          <button
            className="rc-icon-button"
            aria-label="Reload the collections"
            onClick={() => void load()}
          >
            <VscRefresh size={13} />
          </button>
        </Tooltip>
        {isOwner && (
          <Tooltip title="Disconnect">
            <button
              className="rc-icon-button"
              aria-label="Disconnect the database"
              onClick={onDisconnect}
            >
              <VscTrash size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="rc-db-tree">
          {collections.length === 0 && (
            <div className="rc-db-empty">No collections in this database.</div>
          )}

          {collections.map((entry) => {
            const key = keyOf(entry);
            const schema = schemas[key];
            const isOpen = expanded.has(key);
            const isActive = active ? keyOf(active) === key : false;

            return (
              <div key={key}>
                <button
                  className="rc-db-table"
                  data-active={isActive}
                  onClick={() => void toggle(entry)}
                  onDoubleClick={() => {
                    setActive(entry);
                    void run(0);
                  }}
                  aria-expanded={isOpen}
                >
                  <VscListTree size={12} />
                  <span>{entry.name}</span>
                  {entry.kind === "view" && (
                    <span className="rc-db-view-tag">view</span>
                  )}
                </button>

                {isOpen && !schema && (
                  <div className="rc-db-column">
                    <span style={{ color: "var(--rc-text-subtle)" }}>sampling…</span>
                  </div>
                )}

                {isOpen && schema && (
                  <>
                    {/* Said out loud, not implied. A collection has no
                        declared schema, and presenting a sampled field list
                        as the truth is the way this view would lie. */}
                    <div className="rc-db-inferred">
                      inferred from {schema.sampled} sampled document
                      {schema.sampled === 1 ? "" : "s"}
                    </div>

                    {schema.fields.length === 0 && (
                      <div className="rc-db-column">
                        <span style={{ color: "var(--rc-text-subtle)" }}>
                          the sample came back empty
                        </span>
                      </div>
                    )}

                    {schema.fields.map((field) => (
                      <div
                        key={field.name}
                        className="rc-db-column"
                        title={presenceLabel(field.presence)}
                      >
                        <span>{field.name}</span>
                        <span className="rc-db-type">
                          {field.types.join(" | ")}
                          {field.presence < 1 && (
                            <span className="rc-db-presence">
                              {" "}
                              {Math.round(field.presence * 100)}%
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
          <div className="rc-db-toolbar">
            <Segmented
              size="small"
              value={mode}
              onChange={(value) => onModeChange(value as "find" | "aggregate")}
              options={[
                { label: "Filter", value: "find" },
                { label: "Pipeline", value: "aggregate" },
              ]}
            />
            <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
              {active ? `${active.database}.${active.name}` : "no collection selected"}
            </span>
          </div>

          <div
            style={{
              height: "38%",
              minHeight: 90,
              borderBottom: "1px solid var(--rc-border)",
            }}
          >
            <Editor
              height="100%"
              language="json"
              theme={monacoTheme}
              value={text}
              onChange={(value) => setText(value ?? "")}
              onMount={handleMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                lineNumbers: "off",
                padding: { top: 10, bottom: 10 },
              }}
            />
          </div>

          <div className="rc-db-toolbar">
            <Button
              type="primary"
              size="small"
              icon={<VscPlay />}
              loading={running}
              disabled={!active}
              onClick={() => void run(0)}
            >
              Run
            </Button>

            {result && (
              <>
                <Button
                  size="small"
                  disabled={skip === 0 || running}
                  onClick={() => void run(Math.max(0, skip - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  size="small"
                  disabled={!result.truncated || running}
                  onClick={() => void run(skip + PAGE_SIZE)}
                >
                  Next
                </Button>
                <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
                  {result.documentCount} document
                  {result.documentCount === 1 ? "" : "s"} · {result.durationMs} ms
                </span>
              </>
            )}

            <span style={{ flex: 1 }} />

            <Tooltip title="Documents">
              <button
                className="rc-icon-button"
                aria-label="Show documents"
                data-active={view === "documents"}
                onClick={() => setView("documents")}
              >
                <VscJson size={13} />
              </button>
            </Tooltip>
            <Tooltip title="Table of top-level fields">
              <button
                className="rc-icon-button"
                aria-label="Show a table"
                data-active={view === "table"}
                onClick={() => setView("table")}
              >
                <VscTable size={13} />
              </button>
            </Tooltip>
          </div>

          {!result && (
            <div className="rc-db-empty">
              {mode === "find"
                ? "Enter a filter document — {} matches everything — and press Ctrl+Enter."
                : "Enter an aggregation pipeline as an array of stages, and press Ctrl+Enter."}
            </div>
          )}

          {result && view === "table" && <DocumentGrid result={result} />}

          {result && view === "documents" && (
            <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
              {result.documents.length === 0 && (
                <div className="rc-db-empty">No documents matched.</div>
              )}
              {result.documents.map((document, index) => (
                <DocumentCard key={index} document={document} index={index} />
              ))}
              {result.truncated && (
                <div className="rc-result-note">
                  Showing {result.documentCount} documents. Use Next, or narrow the
                  filter, to see the rest.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
