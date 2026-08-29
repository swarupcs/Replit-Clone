import { Pool } from "pg";
import type { PoolClient } from "pg";
import { prisma } from "../lib/prisma.js";
import { open, seal } from "../lib/secretBox.js";
import {
  checkConnectionString,
  checkMongoConnectionString,
  redactConnectionString,
  type CheckedConnection,
  type CheckedMongoConnection,
} from "../lib/connectionGuard.js";
import { logger } from "../lib/logger.js";
import { DatabaseQueryError } from "./databaseErrors.js";
import { closeConnection as closeMongoConnection } from "./mongoQueryService.js";

/** How long any one statement may run before the database cancels it.
 *
 *  Set on the session rather than enforced in Node: a cartesian join holds a
 *  connection and a request open for as long as it likes, and only the
 *  database can actually stop it. */
const STATEMENT_TIMEOUT_MS = 10_000;

/** Rows returned to the client. `execCapture` learned this lesson first: an
 *  unbounded result buffers into the server's memory before anyone sees it. */
export const ROW_CAP = 1_000;

/** Bytes of serialised result. A thousand rows of `bytea` is not a thousand
 *  small rows, so the row cap alone does not bound the response. */
const BYTE_CAP = 2_000_000;

/** One pool per project, idle-closed. A pool per open tab exhausts
 *  `max_connections` at around twenty users. */
const POOLS = new Map<string, { pool: Pool; timer: NodeJS.Timeout }>();
const POOL_IDLE_MS = 60_000;

export interface StoredConnection {
  engine: string;
  label: string;
}

export interface QueryColumn {
  name: string;
  /** Postgres type oid, so the client can render bytea as a size and json as
   *  a tree rather than guessing from the value. */
  dataTypeId: number;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  rowCount: number;
  /** True when the row cap cut the result short, so the UI can say so rather
   *  than quietly showing part of an answer as if it were all of it. */
  truncated: boolean;
  durationMs: number;
}

// Re-exported so existing importers keep one place to import it from.
export { DatabaseQueryError } from "./databaseErrors.js";

/** Stores a connection string for a project, after checking it.
 *
 *  The check happens here rather than at the edge so there is no route into
 *  storage that skips it.
 */
export async function setConnection(
  projectId: string,
  url: string,
): Promise<StoredConnection> {
  // Which check runs is decided by the scheme rather than by trying one and
  // falling back: a Mongo string names a seed list that `new URL` cannot
  // parse at all, so "the Postgres check threw" says nothing useful about it.
  const isMongo = /^mongodb(\+srv)?:/i.test(url.trim());

  const checked = isMongo
    ? await checkMongoConnectionString(url)
    : await checkConnectionString(url);

  const label = isMongo
    ? (checked as CheckedMongoConnection).label
    : `${(checked as CheckedConnection).host}:${(checked as CheckedConnection).port}`;

  const record = {
    urlCipher: seal(checked.url),
    engine: checked.scheme,
    label,
  };

  await prisma.projectDatabaseConnection.upsert({
    where: { projectId },
    create: { projectId, ...record },
    update: record,
  });

  // Replacing the connection must not leave the old one connected, on either
  // engine — the previous string is a credential that has just been revoked
  // as far as this project is concerned.
  closePool(projectId);
  closeMongoConnection(projectId);

  return { engine: checked.scheme, label };
}

export async function getConnection(
  projectId: string,
): Promise<StoredConnection | null> {
  const row = await prisma.projectDatabaseConnection.findUnique({
    where: { projectId },
  });
  return row ? { engine: row.engine, label: row.label } : null;
}

export async function removeConnection(projectId: string): Promise<void> {
  closePool(projectId);
  closeMongoConnection(projectId);
  await prisma.projectDatabaseConnection
    .delete({ where: { projectId } })
    .catch(() => ({}));
}

function closePool(projectId: string): void {
  const existing = POOLS.get(projectId);
  if (!existing) return;
  clearTimeout(existing.timer);
  POOLS.delete(projectId);
  void existing.pool.end().catch(() => undefined);
}

function touchPool(projectId: string): void {
  const existing = POOLS.get(projectId);
  if (!existing) return;
  clearTimeout(existing.timer);
  existing.timer = setTimeout(() => closePool(projectId), POOL_IDLE_MS);
}

async function poolFor(projectId: string): Promise<Pool> {
  const existing = POOLS.get(projectId);
  if (existing) {
    touchPool(projectId);
    return existing.pool;
  }

  const row = await prisma.projectDatabaseConnection.findUnique({
    where: { projectId },
  });
  if (!row) {
    throw new DatabaseQueryError(
      "This project has no database connection yet.",
      "NO_CONNECTION",
    );
  }
  if (row.engine !== "postgresql") {
    // `pg` would accept a mongodb:// string and fail with something about a
    // password, which is a worse answer than the true one.
    throw new DatabaseQueryError(
      "This project's database is not Postgres.",
      "ENGINE_MISMATCH",
    );
  }

  let url: string;
  try {
    url = open(row.urlCipher);
  } catch {
    // A key rotation, or a tampered row. Dropping it is better than leaving
    // something that can never be opened and will fail on every query.
    await removeConnection(projectId);
    throw new DatabaseQueryError(
      "The stored connection could not be read and has been removed. Add it again.",
      "CONNECTION_UNREADABLE",
    );
  }

  // Re-checked on every pool creation rather than trusted because it was
  // checked when stored: DNS moves, and a name that was public last week can
  // point at loopback today. The address the guard approved is what the
  // socket is given.
  const checked = await checkConnectionString(url);

  const pool = new Pool({
    connectionString: checked.url,
    host: checked.address,
    max: 1,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: POOL_IDLE_MS,
    application_name: "replit-clone-query-editor",
  });

  // A pool that emits an unhandled 'error' takes the process down with it.
  pool.on("error", () => undefined);

  const timer = setTimeout(() => closePool(projectId), POOL_IDLE_MS);
  POOLS.set(projectId, { pool, timer });
  return pool;
}

/** Rough size of a result, for the byte cap. Measured on the way out rather
 *  than predicted: the alternative is guessing from column types, and `text`
 *  says nothing about length. */
function serialisedSize(rows: unknown[][]): number {
  let bytes = 0;
  for (const row of rows) {
    for (const value of row) {
      if (value === null || value === undefined) continue;
      bytes += typeof value === "string" ? value.length : 8;
      if (bytes > BYTE_CAP) return bytes;
    }
  }
  return bytes;
}

/** Runs one statement.
 *
 *  `readOnly` is enforced by the database, inside a read-only transaction,
 *  not by inspecting the SQL. Parsing SQL to decide whether something is
 *  "just a SELECT" is a losing game — CTEs with INSERT ... RETURNING, DO
 *  blocks, functions with side effects — so classification may warn and
 *  must never permit.
 */
export async function runQuery(
  projectId: string,
  sql: string,
  { readOnly }: { readOnly: boolean },
): Promise<QueryResult> {
  const pool = await poolFor(projectId);
  const started = Date.now();

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new DatabaseQueryError(
      redactConnectionString(
        error instanceof Error ? error.message : "Could not reach the database.",
      ),
      "CONNECT_FAILED",
    );
  }

  try {
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    // Everything runs in a transaction so a read-only one is available; a
    // writable session gets the same shape, which keeps one code path.
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");

    const result = await client.query({ text: sql, rowMode: "array" });
    await client.query("COMMIT");

    const all = (result.rows ?? []) as unknown[][];
    const rows = all.slice(0, ROW_CAP);
    const truncated = all.length > ROW_CAP || serialisedSize(rows) > BYTE_CAP;

    return {
      columns: (result.fields ?? []).map((field) => ({
        name: field.name,
        dataTypeId: field.dataTypeID,
      })),
      rows: truncated ? rows.slice(0, ROW_CAP) : rows,
      rowCount: result.rowCount ?? all.length,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);

    // Never the query text: it contains the user's data by definition.
    logger.warn("database query failed", {
      projectId,
      durationMs: Date.now() - started,
    });

    const message =
      error instanceof Error ? error.message : "The query could not be run.";
    throw new DatabaseQueryError(redactConnectionString(message), "QUERY_FAILED");
  } finally {
    client.release();
    touchPool(projectId);
  }
}

/** Closes every pool. For shutdown, and for tests. */
export async function closeAllPools(): Promise<void> {
  const ids = [...POOLS.keys()];
  for (const id of ids) closePool(id);
  await Promise.resolve();
}

/** One column of a table, as the schema tree shows it. */
export interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: IntrospectedColumn[];
}

/** The query behind the schema tree.
 *
 *  One statement rather than one per table: a hundred tables would otherwise
 *  be a hundred round trips, and the tree wants all of it at once anyway.
 *  System schemas are excluded — nobody browsing their own database is
 *  looking for `pg_catalog`.
 */
const INTROSPECT_SQL = `
  SELECT
    c.table_schema,
    c.table_name,
    t.table_type,
    c.column_name,
    c.data_type,
    c.is_nullable,
    COALESCE(pk.is_pk, false) AS is_pk
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  LEFT JOIN (
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name, true AS is_pk
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
  ) pk
    ON pk.table_schema = c.table_schema
   AND pk.table_name = c.table_name
   AND pk.column_name = c.column_name
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY c.table_schema, c.table_name, c.ordinal_position
`;

/** Shapes introspection rows into the tree's tables.
 *
 *  Separate from the query so it can be tested without a database — the SQL
 *  is the part a live connection proves, the grouping is the part that has
 *  edge cases. */
export function groupIntrospection(rows: unknown[][]): IntrospectedTable[] {
  const tables = new Map<string, IntrospectedTable>();

  for (const row of rows) {
    const [schema, name, tableType, column, dataType, nullable, isPk] = row as [
      string,
      string,
      string,
      string,
      string,
      string,
      boolean,
    ];

    const key = `${schema}.${name}`;
    let table = tables.get(key);
    if (!table) {
      table = {
        schema,
        name,
        kind: tableType === "VIEW" ? "view" : "table",
        columns: [],
      };
      tables.set(key, table);
    }

    table.columns.push({
      name: column,
      dataType,
      nullable: nullable === "YES",
      isPrimaryKey: Boolean(isPk),
    });
  }

  return [...tables.values()];
}

export async function introspect(projectId: string): Promise<IntrospectedTable[]> {
  const result = await runQuery(projectId, INTROSPECT_SQL, { readOnly: true });
  return groupIntrospection(result.rows);
}

/** A page of one table, for the grid.
 *
 *  The identifiers are quoted rather than interpolated raw, and they come
 *  from introspection rather than from the client — but they are quoted
 *  anyway, because "it came from our own query" is exactly the assumption
 *  that stops being true when someone adds a code path later.
 */
export async function tablePage(
  projectId: string,
  schema: string,
  table: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<QueryResult> {
  const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
  const size = Math.min(Math.max(1, limit), ROW_CAP);
  const from = Math.max(0, offset);

  return runQuery(
    projectId,
    `SELECT * FROM ${quote(schema)}.${quote(table)} LIMIT ${size} OFFSET ${from}`,
    { readOnly: true },
  );
}
