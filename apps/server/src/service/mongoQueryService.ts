import { BSON, MongoClient } from "mongodb";
import type { Document } from "mongodb";
import { prisma } from "../lib/prisma.js";
import { open } from "../lib/secretBox.js";
import {
  checkMongoConnectionString,
  redactConnectionString,
} from "../lib/connectionGuard.js";
import { logger } from "../lib/logger.js";
import { DatabaseQueryError } from "./databaseErrors.js";

/** How long any one operation may run before the server cancels it.
 *
 *  `maxTimeMS` is the Mongo equivalent of `statement_timeout`, and it is set
 *  for the same reason: an unindexed `$lookup` over a large collection holds
 *  a connection and a request open for as long as it likes, and only the
 *  database can actually stop it. */
const MAX_TIME_MS = 10_000;

/** Documents returned to the client. */
export const DOC_CAP = 200;

/** Bytes of serialised result. A document may be 16 MB on its own, so the
 *  document cap alone does not bound the response. */
const BYTE_CAP = 2_000_000;

/** Documents sampled to infer a collection's shape.
 *
 *  A collection has no declared schema, so this is the whole basis of the
 *  field list. Three hundred is enough to find the fields that are always
 *  there and cheap enough to run when a user expands a node; it is not enough
 *  to promise anything about a rare field, which is exactly why the result is
 *  labelled inferred and carries how many documents it saw. */
const SAMPLE_SIZE = 300;

/** Collections listed before the tree stops asking. A database with tens of
 *  thousands of collections is a different product than this panel. */
const COLLECTION_CAP = 500;

const CLIENTS = new Map<string, { client: MongoClient; timer: NodeJS.Timeout }>();
const CLIENT_IDLE_MS = 60_000;

/** Aggregation stages that write.
 *
 *  This is a structural check on a parsed pipeline, not the kind of text
 *  classification ruled out on the SQL side: a pipeline is an array of
 *  objects whose first key is the stage name, and `$out` and `$merge` are
 *  the complete set of stages that write. There is no CTE-with-RETURNING equivalent to hide
 *  behind, and no other code path in this service calls anything but `find`
 *  and `aggregate`, so a read-only session genuinely cannot write. */
const WRITING_STAGES = new Set(["$out", "$merge"]);

export interface InferredField {
  name: string;
  /** Every BSON type seen for this field, because a field is not required to
   *  hold one type and pretending otherwise is how a schema view lies. */
  types: string[];
  /** Fraction of the sampled documents that had this field, 0–1. Presence is
   *  what makes "inferred" concrete: a field at 0.02 is not part of the
   *  shape, and a label alone would not say so. */
  presence: number;
}

export interface InferredCollection {
  database: string;
  name: string;
  kind: "collection" | "view";
}

export interface CollectionSchema {
  database: string;
  collection: string;
  /** How many documents the inference actually saw. Zero means the sample
   *  came back empty, which is not the same as "no fields". */
  sampled: number;
  fields: InferredField[];
}

export interface MongoQueryResult {
  /** Relaxed-EJSON documents, already plain JSON. `_id` stays visible as
   *  `{"$oid": …}` rather than being flattened to a string: a document is not
   *  a row, and the types are half of what the detail panel is for. */
  documents: unknown[];
  /** Top-level field names in first-seen order, for the summary grid. */
  fields: string[];
  documentCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface MongoQueryRequest {
  database?: string;
  collection: string;
  mode: "find" | "aggregate";
  /** An EJSON filter document, or an EJSON aggregation pipeline. Parsed here
   *  rather than on the client because `JSON.parse` loses every BSON type —
   *  an `_id` filter would silently become a string and match nothing. */
  text: string;
  sort?: string;
  limit?: number;
  skip?: number;
}

function closeClient(projectId: string): void {
  const existing = CLIENTS.get(projectId);
  if (!existing) return;
  clearTimeout(existing.timer);
  CLIENTS.delete(projectId);
  void existing.client.close().catch(() => undefined);
}

function touchClient(projectId: string): void {
  const existing = CLIENTS.get(projectId);
  if (!existing) return;
  clearTimeout(existing.timer);
  existing.timer = setTimeout(() => closeClient(projectId), CLIENT_IDLE_MS);
}

/** The database named in the connection string, if it names one.
 *
 *  Atlas hands out strings with no default database at all, so this is
 *  allowed to come back empty and the caller asks the server what exists.
 */
export function defaultDatabaseOf(url: string): string | undefined {
  const afterScheme = url.slice(url.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return undefined;
  const rest = afterScheme.slice(slash + 1);
  const name = rest.split("?")[0] ?? "";
  return name ? decodeURIComponent(name) : undefined;
}

async function connectionFor(projectId: string): Promise<{
  client: MongoClient;
  defaultDatabase: string | undefined;
}> {
  const row = await prisma.projectDatabaseConnection.findUnique({
    where: { projectId },
  });
  if (!row) {
    throw new DatabaseQueryError(
      "This project has no database connection yet.",
      "NO_CONNECTION",
    );
  }
  if (row.engine !== "mongodb") {
    throw new DatabaseQueryError(
      "This project's database is not MongoDB.",
      "ENGINE_MISMATCH",
    );
  }

  let url: string;
  try {
    url = open(row.urlCipher);
  } catch {
    await prisma.projectDatabaseConnection
      .delete({ where: { projectId } })
      .catch(() => ({}));
    closeClient(projectId);
    throw new DatabaseQueryError(
      "The stored connection could not be read and has been removed. Add it again.",
      "CONNECTION_UNREADABLE",
    );
  }

  const defaultDatabase = defaultDatabaseOf(url);

  const existing = CLIENTS.get(projectId);
  if (existing) {
    touchClient(projectId);
    return { client: existing.client, defaultDatabase };
  }

  // Re-checked on every connect rather than trusted because it was checked
  // when stored: DNS moves, and a name that was public last week can point at
  // loopback today. Every host in the seed list is checked, and for
  // `mongodb+srv://` the SRV targets are.
  await checkMongoConnectionString(url);

  const client = new MongoClient(url, {
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    appName: "replit-clone-query-editor",
  });

  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new DatabaseQueryError(
      redactConnectionString(
        error instanceof Error ? error.message : "Could not reach the database.",
      ),
      "CONNECT_FAILED",
    );
  }

  const timer = setTimeout(() => closeClient(projectId), CLIENT_IDLE_MS);
  CLIENTS.set(projectId, { client, timer });
  return { client, defaultDatabase };
}

/** Turns BSON into plain JSON the response can carry.
 *
 *  Relaxed rather than canonical: canonical wraps every number as
 *  `{"$numberInt": "3"}`, which is precise and unreadable. Relaxed keeps the
 *  types that matter — ObjectId, Date, Decimal128 — and leaves an ordinary
 *  number an ordinary number. */
function toPlain(value: unknown): unknown {
  return JSON.parse(BSON.EJSON.stringify(value, { relaxed: true }));
}

/** Parses user text as EJSON, with an error that says where it broke. */
function parseEjson(text: string, what: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new DatabaseQueryError(`A ${what} is required.`, "QUERY_REQUIRED");
  }
  try {
    return BSON.EJSON.parse(trimmed, { relaxed: true });
  } catch (error) {
    throw new DatabaseQueryError(
      `That ${what} is not valid JSON: ${
        error instanceof Error ? error.message : "could not be parsed"
      }`,
      "QUERY_MALFORMED",
    );
  }
}

/** The BSON type of a value, as the schema view names it. */
export function bsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";

  const constructorName = (value as { _bsontype?: string })._bsontype;
  if (constructorName) return constructorName.toLowerCase();

  if (value instanceof Date) return "date";
  const primitive = typeof value;
  if (primitive === "number") {
    return Number.isInteger(value) ? "int" : "double";
  }
  if (primitive === "object") return "object";
  return primitive;
}

/** Folds a sample of documents into a field list with presence ratios.
 *
 *  Separate from the query so it can be tested without a database — the
 *  `$sample` stage is the part a live connection proves, the folding is the
 *  part with edge cases (a field that is sometimes an array, a field present
 *  but null, a document with no fields at all). */
export function inferFields(documents: Document[]): InferredField[] {
  const seen = new Map<string, { count: number; types: Set<string> }>();

  for (const document of documents) {
    for (const [name, value] of Object.entries(document ?? {})) {
      let entry = seen.get(name);
      if (!entry) {
        entry = { count: 0, types: new Set() };
        seen.set(name, entry);
      }
      entry.count += 1;
      entry.types.add(bsonTypeOf(value));
    }
  }

  const total = documents.length || 1;
  return [...seen.entries()]
    .map(([name, entry]) => ({
      name,
      types: [...entry.types].sort(),
      presence: entry.count / total,
    }))
    .sort((left, right) => {
      // `_id` first because it is the identity, then by how reliably a field
      // is there, then by name — a field on every document is part of the
      // shape and a field on three of them is not.
      if (left.name === "_id") return -1;
      if (right.name === "_id") return 1;
      if (left.presence !== right.presence) return right.presence - left.presence;
      return left.name.localeCompare(right.name);
    });
}

/** Every database and collection the connection can see. */
export async function listCollections(
  projectId: string,
): Promise<InferredCollection[]> {
  const { client, defaultDatabase } = await connectionFor(projectId);

  try {
    let databases: string[];
    if (defaultDatabase) {
      databases = [defaultDatabase];
    } else {
      // No database in the string — an Atlas default. Ask, and say something
      // useful if the user is not allowed to.
      try {
        const listed = await client.db("admin").admin().listDatabases();
        databases = listed.databases
          .map((entry) => entry.name)
          .filter((name) => !["admin", "local", "config"].includes(name));
      } catch {
        throw new DatabaseQueryError(
          "This connection string names no database, and listing databases was refused. " +
            "Add the database to the end of the connection string.",
          "DATABASE_REQUIRED",
        );
      }
    }

    const collections: InferredCollection[] = [];
    for (const database of databases) {
      const listed = await client
        .db(database)
        .listCollections({}, { nameOnly: false })
        .toArray();

      for (const entry of listed.slice(0, COLLECTION_CAP)) {
        collections.push({
          database,
          name: entry.name,
          kind: entry.type === "view" ? "view" : "collection",
        });
      }
    }

    return collections;
  } catch (error) {
    if (error instanceof DatabaseQueryError) throw error;
    throw new DatabaseQueryError(
      redactConnectionString(
        error instanceof Error ? error.message : "The collections could not be listed.",
      ),
      "QUERY_FAILED",
    );
  } finally {
    touchClient(projectId);
  }
}

/** Samples a collection and reports the shape it found.
 *
 *  Per collection and on demand rather than for the whole database at once:
 *  there is no Mongo equivalent of one introspection query, so eager
 *  inference would be one `$sample` per collection on every panel open.
 */
export async function inferCollectionSchema(
  projectId: string,
  database: string,
  collection: string,
): Promise<CollectionSchema> {
  const { client, defaultDatabase } = await connectionFor(projectId);
  const name = database || defaultDatabase;
  if (!name) {
    throw new DatabaseQueryError("A database is required.", "DATABASE_REQUIRED");
  }

  try {
    const documents = await client
      .db(name)
      .collection(collection)
      .aggregate([{ $sample: { size: SAMPLE_SIZE } }], { maxTimeMS: MAX_TIME_MS })
      .toArray();

    return {
      database: name,
      collection,
      sampled: documents.length,
      fields: inferFields(documents),
    };
  } catch (error) {
    logger.warn("mongo schema inference failed", { projectId });
    throw new DatabaseQueryError(
      redactConnectionString(
        error instanceof Error ? error.message : "The collection could not be sampled.",
      ),
      "QUERY_FAILED",
    );
  } finally {
    touchClient(projectId);
  }
}

/** Rejects a pipeline that would write, for a read-only session. */
export function assertReadOnlyPipeline(pipeline: Document[]): void {
  for (const stage of pipeline) {
    for (const key of Object.keys(stage ?? {})) {
      if (WRITING_STAGES.has(key)) {
        throw new DatabaseQueryError(
          `${key} writes to a collection, and this session is read-only.`,
          "READ_ONLY",
        );
      }
    }
  }
}

/** Rough size of a result, for the byte cap. */
function serialisedSize(documents: unknown[]): number {
  let bytes = 0;
  for (const document of documents) {
    bytes += JSON.stringify(document)?.length ?? 0;
    if (bytes > BYTE_CAP) return bytes;
  }
  return bytes;
}

/** Runs one find or aggregation.
 *
 *  There is deliberately no path here that updates, inserts or deletes.
 *  Inline editing stays out of the first version because an update
 *  generated from a grid needs a reliable identity, and this service is the
 *  place that would have to have it.
 */
export async function runMongoQuery(
  projectId: string,
  request: MongoQueryRequest,
  { readOnly }: { readOnly: boolean },
): Promise<MongoQueryResult> {
  const { client, defaultDatabase } = await connectionFor(projectId);
  const database = request.database || defaultDatabase;
  if (!database) {
    throw new DatabaseQueryError("A database is required.", "DATABASE_REQUIRED");
  }
  if (!request.collection) {
    throw new DatabaseQueryError("A collection is required.", "COLLECTION_REQUIRED");
  }

  const limit = Math.min(Math.max(1, request.limit ?? DOC_CAP), DOC_CAP);
  const skip = Math.max(0, request.skip ?? 0);
  const started = Date.now();

  try {
    const target = client.db(database).collection(request.collection);
    let documents: Document[];

    if (request.mode === "aggregate") {
      const pipeline = parseEjson(request.text, "pipeline");
      if (!Array.isArray(pipeline)) {
        throw new DatabaseQueryError(
          "An aggregation pipeline is an array of stages.",
          "QUERY_MALFORMED",
        );
      }
      if (readOnly) assertReadOnlyPipeline(pipeline as Document[]);

      // Skip and limit are appended rather than applied to the cursor so they
      // run inside the pipeline, where the server can use them: a `$limit`
      // after a `$sort` lets Mongo do a top-k rather than sorting everything.
      // One extra document is asked for, which is how truncation is detected
      // without a second count query.
      documents = await target
        .aggregate(
          [
            ...(pipeline as Document[]),
            ...(skip ? [{ $skip: skip }] : []),
            { $limit: limit + 1 },
          ],
          { maxTimeMS: MAX_TIME_MS },
        )
        .toArray();
    } else {
      const filter = parseEjson(request.text, "filter");
      if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
        throw new DatabaseQueryError(
          "A filter is a single document, not an array.",
          "QUERY_MALFORMED",
        );
      }

      const sort = request.sort?.trim()
        ? (parseEjson(request.sort, "sort") as Document)
        : undefined;

      let cursor = target.find(filter as Document, { maxTimeMS: MAX_TIME_MS });
      if (sort) cursor = cursor.sort(sort);
      documents = await cursor.skip(skip).limit(limit + 1).toArray();
    }

    const overflowed = documents.length > limit;
    const kept = documents.slice(0, limit).map(toPlain);
    const truncated = overflowed || serialisedSize(kept) > BYTE_CAP;

    // First-seen order rather than sorted: the first document's key order is
    // the closest thing a collection has to a column order, and re-sorting it
    // would put `_id` in the middle.
    const fields: string[] = [];
    for (const document of kept) {
      for (const key of Object.keys(document ?? {})) {
        if (!fields.includes(key)) fields.push(key);
      }
    }

    return {
      documents: kept,
      fields,
      documentCount: kept.length,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof DatabaseQueryError) throw error;

    // Never the query text: it contains the user's data by definition.
    logger.warn("mongo query failed", {
      projectId,
      durationMs: Date.now() - started,
    });

    throw new DatabaseQueryError(
      redactConnectionString(
        error instanceof Error ? error.message : "The query could not be run.",
      ),
      "QUERY_FAILED",
    );
  } finally {
    touchClient(projectId);
  }
}

/** Closes one project's client. Called when its connection record changes:
 *  a replaced connection string must not leave the old one connected. */
export function closeConnection(projectId: string): void {
  closeClient(projectId);
}

/** Closes every client. For shutdown, for a connection change, and for tests. */
export async function closeAllClients(): Promise<void> {
  for (const id of [...CLIENTS.keys()]) closeClient(id);
  await Promise.resolve();
}
