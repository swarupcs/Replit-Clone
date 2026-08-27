import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Spin, Tooltip, message } from "antd";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import { VscDatabase, VscPlay, VscRefresh, VscTable, VscTrash } from "react-icons/vsc";
import {
  getDatabaseConnectionApi,
  getDatabaseSchemaApi,
  getDatabaseTableApi,
  removeDatabaseConnectionApi,
  runDatabaseQueryApi,
  setDatabaseConnectionApi,
  type DatabaseConnection,
  type IntrospectedTable,
  type QueryResult,
} from "../../../apis/projects.ts";
import { completionsFor } from "../../../lib/sqlCompletion.ts";
import { renderCell } from "../../../lib/cellRender.ts";
import { useThemeMode } from "../../../hooks/useThemeMode.ts";
import { MongoWorkbench } from "./MongoWorkbench.tsx";

const PAGE_SIZE = 100;

interface Props {
  projectId: string;
  /** False for a viewer. The endpoint still refuses a write — the database
   *  does, inside a read-only transaction — but there is no reason to offer
   *  the connection form to somebody it will refuse. */
  isOwner: boolean;
}

function errorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } }).response;
  return response?.data?.message ?? "Something went wrong.";
}

/** The result grid.
 *
 *  Server-paged and capped upstream, so this never receives a whole table.
 *  Rendering is by type rather than by `String(value)` — §7.6's point that
 *  telling NULL from an empty string is most of what a grid is for.
 */
const ResultGrid = ({ result }: { result: QueryResult }) => {
  if (result.columns.length === 0) {
    return (
      <div style={{ padding: 16, color: "var(--rc-text-muted)", fontSize: 13 }}>
        {result.rowCount} row{result.rowCount === 1 ? "" : "s"} affected ·{" "}
        {result.durationMs} ms
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
      <table className="rc-result-grid">
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column.name}>{column.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, cellIndex) => {
                const cell = renderCell(value, result.columns[cellIndex]?.dataTypeId);
                return (
                  <td
                    key={cellIndex}
                    data-kind={cell.kind}
                    title={cell.kind === "json" ? cell.text : undefined}
                  >
                    {cell.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {result.truncated && (
        <div className="rc-result-note">
          Showing the first {result.rows.length} rows. Add a LIMIT to see a
          specific part of the result.
        </div>
      )}
    </div>
  );
};

/** Schema tree, query editor and result grid.
 *
 *  Pointed at a database the user already has — a Neon, Supabase, Atlas or
 *  Railway one — which is §0.3's second decision: the client ships before any
 *  managed-database infrastructure, because it is useful alone and it is what
 *  makes the managed database worth paying for later.
 */
export const DatabasePanel = ({ projectId, isOwner }: Props) => {
  const [connection, setConnection] = useState<DatabaseConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [tables, setTables] = useState<IntrospectedTable[]>([]);
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const monacoTheme = useThemeMode() === "light" ? "alucard" : "dracula";

  /** Kept in a ref as well as state so the completion provider — registered
   *  once — reads the current schema rather than the one that existed when it
   *  was registered. */
  const tablesRef = useRef<IntrospectedTable[]>([]);
  tablesRef.current = tables;

  const loadSchema = useCallback(async () => {
    try {
      setTables(await getDatabaseSchemaApi(projectId));
    } catch (error) {
      void message.error(errorMessage(error));
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const existing = await getDatabaseConnectionApi(projectId);
        if (cancelled) return;
        setConnection(existing);
        if (existing) await loadSchema();
      } catch {
        // A project with no connection is the common case, not an error.
        if (!cancelled) setConnection(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, loadSchema]);

  const connect = async () => {
    setConnecting(true);
    try {
      setConnection(await setDatabaseConnectionApi(projectId, url));
      // Cleared immediately: it is a credential, and there is no reason for
      // it to sit in a form field after it has been stored.
      setUrl("");
      await loadSchema();
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await removeDatabaseConnectionApi(projectId).catch(() => undefined);
    setConnection(null);
    setTables([]);
    setResult(null);
  };

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setResult(await runDatabaseQueryApi(projectId, sql));
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setRunning(false);
    }
  }, [projectId, sql]);

  const openTable = async (table: IntrospectedTable) => {
    setRunning(true);
    try {
      setResult(
        await getDatabaseTableApi(projectId, table.schema, table.name, PAGE_SIZE, 0),
      );
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  const handleMount = (_editor: unknown, monaco: Monaco) => {
    monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model, position) => {
        const before = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const word = model.getWordUntilPosition(position);

        return {
          suggestions: completionsFor(before, tablesRef.current).map((item) => ({
            label: item.label,
            detail: item.detail,
            insertText: item.label,
            kind:
              item.kind === "table"
                ? monaco.languages.CompletionItemKind.Struct
                : monaco.languages.CompletionItemKind.Field,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            },
          })),
        };
      },
    });
  };

  const grouped = useMemo(() => {
    const bySchema = new Map<string, IntrospectedTable[]>();
    for (const table of tables) {
      const list = bySchema.get(table.schema) ?? [];
      list.push(table);
      bySchema.set(table.schema, list);
    }
    return [...bySchema.entries()];
  }, [tables]);

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
        <Spin />
      </div>
    );
  }

  if (!connection) {
    return (
      <div style={{ padding: 16 }}>
        <Empty
          image={<VscDatabase size={40} color="var(--rc-text-subtle)" />}
          description={
            <span style={{ color: "var(--rc-text-muted)", fontSize: 13 }}>
              {isOwner
                ? "Point this project at a Postgres or MongoDB database to browse it and run queries."
                : "No database is connected to this project."}
            </span>
          }
        />

        {isOwner && (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Input.Password
              placeholder="postgresql://… or mongodb+srv://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onPressEnter={() => void connect()}
            />
            <Button
              type="primary"
              loading={connecting}
              disabled={!url.trim()}
              onClick={() => void connect()}
            >
              Connect
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Routed on engine rather than switching labels inside one workbench. §7.6
  // is explicit that a Mongo editor takes filter documents and pipelines
  // rather than statements, and a shared component would have to pretend
  // otherwise in every branch.
  if (connection.engine === "mongodb") {
    return (
      <MongoWorkbench
        projectId={projectId}
        label={connection.label}
        isOwner={isOwner}
        onDisconnect={() => void disconnect()}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="rc-db-header">
        <VscDatabase size={13} />
        <span style={{ fontSize: 12, color: "var(--rc-text-muted)" }}>
          {connection.label}
        </span>
        <span style={{ flex: 1 }} />
        <Tooltip title="Reload the schema">
          <button
            className="rc-icon-button"
            aria-label="Reload the schema"
            onClick={() => void loadSchema()}
          >
            <VscRefresh size={13} />
          </button>
        </Tooltip>
        {isOwner && (
          <Tooltip title="Disconnect">
            <button
              className="rc-icon-button"
              aria-label="Disconnect the database"
              onClick={() => void disconnect()}
            >
              <VscTrash size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="rc-db-tree">
          {grouped.map(([schema, schemaTables]) => (
            <div key={schema}>
              <div className="rc-db-schema">{schema}</div>
              {schemaTables.map((table) => {
                const key = `${table.schema}.${table.name}`;
                const isOpen = expanded.has(key);
                return (
                  <div key={key}>
                    <button
                      className="rc-db-table"
                      onClick={() => {
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                      onDoubleClick={() => void openTable(table)}
                      aria-expanded={isOpen}
                    >
                      <VscTable size={12} />
                      <span>{table.name}</span>
                      {table.kind === "view" && (
                        <span className="rc-db-view-tag">view</span>
                      )}
                    </button>

                    {isOpen &&
                      table.columns.map((column) => (
                        <div key={column.name} className="rc-db-column">
                          <span>{column.name}</span>
                          <span className="rc-db-type">
                            {column.isPrimaryKey ? "pk · " : ""}
                            {column.dataType}
                          </span>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ height: "40%", minHeight: 90, borderBottom: "1px solid var(--rc-border)" }}>
            <Editor
              height="100%"
              language="sql"
              theme={monacoTheme}
              value={sql}
              onChange={(value) => setSql(value ?? "")}
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
              onClick={() => void run()}
            >
              Run
            </Button>
            {result && !running && (
              <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
                {result.rowCount} row{result.rowCount === 1 ? "" : "s"} ·{" "}
                {result.durationMs} ms
              </span>
            )}
          </div>

          {result ? (
            <ResultGrid result={result} />
          ) : (
            <div style={{ padding: 16, color: "var(--rc-text-subtle)", fontSize: 13 }}>
              Run a statement, or double-click a table to browse it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
