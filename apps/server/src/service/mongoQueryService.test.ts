import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, close, db, collection, find, aggregate, listCollectionsFn } =
  vi.hoisted(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    db: vi.fn(),
    collection: vi.fn(),
    find: vi.fn(),
    aggregate: vi.fn(),
    listCollectionsFn: vi.fn(),
  }));

// The real BSON is kept: EJSON parsing and serialisation are half of what
// this service does, and a double for them would test the double.
vi.mock("mongodb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MongoClient: class {
    connect = connect;
    close = close;
    db = db;
  },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    projectDatabaseConnection: {
      findUnique: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

vi.mock("../lib/secretBox.js", () => ({
  seal: (value: string) => `v1.${Buffer.from(value).toString("base64url")}`,
  open: (value: string) => {
    if (!value.startsWith("v1.")) throw new Error("cannot open");
    return Buffer.from(value.slice(3), "base64url").toString();
  },
}));

const { checkMongoConnectionString } = vi.hoisted(() => ({
  checkMongoConnectionString: vi.fn(),
}));
vi.mock("../lib/connectionGuard.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkMongoConnectionString,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const service = await import("./mongoQueryService.js");
const { DatabaseQueryError } = await import("./databaseErrors.js");
const { ObjectId } = await import("mongodb");

const URL_ = "mongodb://user:secret@db.example.com:27017/shop";

/** A cursor that records what was asked of it and answers with `documents`. */
function cursorOf(documents: unknown[]) {
  const calls: Record<string, unknown> = {};
  const cursor = {
    sort: vi.fn((value: unknown) => {
      calls["sort"] = value;
      return cursor;
    }),
    skip: vi.fn((value: unknown) => {
      calls["skip"] = value;
      return cursor;
    }),
    limit: vi.fn((value: unknown) => {
      calls["limit"] = value;
      return cursor;
    }),
    toArray: vi.fn().mockResolvedValue(documents),
    calls,
  };
  return cursor;
}

beforeEach(async () => {
  await service.closeAllClients();
  vi.clearAllMocks();

  connect.mockResolvedValue(undefined);
  checkMongoConnectionString.mockResolvedValue({ url: URL_, scheme: "mongodb" });
  prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
    projectId: "p1",
    engine: "mongodb",
    urlCipher: `v1.${Buffer.from(URL_).toString("base64url")}`,
    label: "db.example.com:27017",
  });

  collection.mockReturnValue({
    find,
    aggregate,
  });
  db.mockReturnValue({
    collection,
    listCollections: listCollectionsFn,
    admin: () => ({ listDatabases: vi.fn() }),
  });
});

describe("bsonTypeOf", () => {
  it.each([
    [null, "null"],
    [[1, 2], "array"],
    [new Date(), "date"],
    ["x", "string"],
    [true, "boolean"],
    [3, "int"],
    [3.5, "double"],
    [{ a: 1 }, "object"],
  ])("names %s", (value, expected) => {
    expect(service.bsonTypeOf(value)).toBe(expected);
  });

  it("names a BSON value by its own type rather than 'object'", () => {
    expect(service.bsonTypeOf(new ObjectId())).toBe("objectid");
  });
});

describe("inferFields", () => {
  it("reports presence as a fraction of the sample, not a boolean", () => {
    // The whole reason inference is labelled inferred: a field on one of
    // four documents is not part of the shape, and only a ratio says so.
    const fields = service.inferFields([
      { _id: 1, name: "a" },
      { _id: 2, name: "b" },
      { _id: 3, name: "c" },
      { _id: 4, name: "d", nickname: "dd" },
    ]);

    expect(fields.map((field) => field.name)).toEqual(["_id", "name", "nickname"]);
    expect(fields.find((field) => field.name === "nickname")?.presence).toBe(0.25);
    expect(fields.find((field) => field.name === "name")?.presence).toBe(1);
  });

  it("records every type a field held rather than the first", () => {
    const fields = service.inferFields([
      { value: 1 },
      { value: "one" },
      { value: null },
    ]);

    expect(fields[0]?.types).toEqual(["int", "null", "string"]);
  });

  it("puts _id first even when a later field is more common", () => {
    const fields = service.inferFields([{ name: "a" }, { _id: 1, name: "b" }]);
    expect(fields[0]?.name).toBe("_id");
  });

  it("survives an empty sample without dividing by zero", () => {
    expect(service.inferFields([])).toEqual([]);
  });
});

describe("defaultDatabaseOf", () => {
  it.each([
    ["mongodb://h/shop", "shop"],
    ["mongodb://h:27017/shop?retryWrites=true", "shop"],
    ["mongodb+srv://u:p@c0.example.net/my%20db", "my db"],
    ["mongodb://h", undefined],
    ["mongodb://h/?retryWrites=true", undefined],
  ])("reads %s", (url, expected) => {
    expect(service.defaultDatabaseOf(url)).toBe(expected);
  });
});

describe("assertReadOnlyPipeline", () => {
  it.each(["$out", "$merge"])("refuses %s", (stage) => {
    expect(() => service.assertReadOnlyPipeline([{ [stage]: "copy" }])).toThrow(
      DatabaseQueryError,
    );
  });

  it("refuses a writing stage that is not the first one", () => {
    expect(() =>
      service.assertReadOnlyPipeline([{ $match: {} }, { $out: "copy" }]),
    ).toThrow(DatabaseQueryError);
  });

  it("allows a pipeline that only reads", () => {
    expect(() =>
      service.assertReadOnlyPipeline([{ $match: { a: 1 } }, { $group: { _id: null } }]),
    ).not.toThrow();
  });
});

describe("runMongoQuery", () => {
  it("parses the filter as EJSON so an _id filter stays an ObjectId", async () => {
    // JSON.parse would turn this into the string "65…" and match nothing.
    const cursor = cursorOf([]);
    find.mockReturnValue(cursor);

    await service.runMongoQuery(
      "p1",
      {
        collection: "orders",
        mode: "find",
        text: '{"_id": {"$oid": "651f1f77bcf86cd799439011"}}',
      },
      { readOnly: true },
    );

    const filter = find.mock.calls[0]?.[0] as { _id: unknown };
    expect(filter._id).toBeInstanceOf(ObjectId);
  });

  it("caps the documents asked for and reports truncation", async () => {
    // One more than the limit is requested, which is how truncation is known
    // without a second count query.
    const cursor = cursorOf(Array.from({ length: 6 }, (_, index) => ({ n: index })));
    find.mockReturnValue(cursor);

    const result = await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "find", text: "{}", limit: 5 },
      { readOnly: true },
    );

    expect(cursor.calls["limit"]).toBe(6);
    expect(result.documents).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("never asks for more than the document cap, whatever the client wants", async () => {
    const cursor = cursorOf([]);
    find.mockReturnValue(cursor);

    await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "find", text: "{}", limit: 100_000 },
      { readOnly: true },
    );

    expect(cursor.calls["limit"]).toBe(service.DOC_CAP + 1);
  });

  it("refuses a writing pipeline stage for a read-only session", async () => {
    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "aggregate", text: '[{"$out": "copy"}]' },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    expect(aggregate).not.toHaveBeenCalled();
  });

  it("allows a writing pipeline stage for a session that may write", async () => {
    aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

    await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "aggregate", text: '[{"$out": "copy"}]' },
      { readOnly: false },
    );

    expect(aggregate).toHaveBeenCalled();
  });

  it("appends skip and limit to the pipeline rather than to the cursor", async () => {
    // Inside the pipeline the server can use them — a $limit after a $sort is
    // a top-k rather than a full sort.
    aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

    await service.runMongoQuery(
      "p1",
      {
        collection: "orders",
        mode: "aggregate",
        text: '[{"$sort": {"total": -1}}]',
        limit: 10,
        skip: 20,
      },
      { readOnly: true },
    );

    expect(aggregate.mock.calls[0]?.[0]).toEqual([
      { $sort: { total: -1 } },
      { $skip: 20 },
      { $limit: 11 },
    ]);
  });

  it("refuses a pipeline that is not an array", async () => {
    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "aggregate", text: '{"$match": {}}' },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "QUERY_MALFORMED" });
  });

  it("refuses a filter that is an array", async () => {
    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "find", text: "[]" },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "QUERY_MALFORMED" });
  });

  it("says where the text broke rather than 'query failed'", async () => {
    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "find", text: "{not json" },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "QUERY_MALFORMED" });
  });

  it("serialises BSON to plain JSON, keeping the types visible", async () => {
    const id = new ObjectId("651f1f77bcf86cd799439011");
    find.mockReturnValue(cursorOf([{ _id: id, total: 12.5 }]));

    const result = await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "find", text: "{}" },
      { readOnly: true },
    );

    // `_id` stays an $oid rather than being flattened to a string: a document
    // is not a row, and the types are half of what the detail panel shows.
    expect(result.documents[0]).toEqual({
      _id: { $oid: "651f1f77bcf86cd799439011" },
      total: 12.5,
    });
    expect(JSON.stringify(result.documents)).toBeTypeOf("string");
  });

  it("collects field names in first-seen order across documents", async () => {
    find.mockReturnValue(
      cursorOf([
        { _id: 1, name: "a" },
        { _id: 2, extra: true },
      ]),
    );

    const result = await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "find", text: "{}" },
      { readOnly: true },
    );

    expect(result.fields).toEqual(["_id", "name", "extra"]);
  });

  it("re-checks the connection string on every connect, not just when stored", async () => {
    find.mockReturnValue(cursorOf([]));

    await service.runMongoQuery(
      "p1",
      { collection: "orders", mode: "find", text: "{}" },
      { readOnly: true },
    );

    expect(checkMongoConnectionString).toHaveBeenCalledWith(URL_);
  });

  it("refuses to reach a Postgres connection through the Mongo path", async () => {
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
      projectId: "p1",
      engine: "postgresql",
      urlCipher: `v1.${Buffer.from("postgresql://h/db").toString("base64url")}`,
      label: "h:5432",
    });

    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "find", text: "{}" },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "ENGINE_MISMATCH" });
  });

  it("drops a stored connection it can no longer open", async () => {
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
      projectId: "p1",
      engine: "mongodb",
      urlCipher: "not-a-sealed-value",
      label: "db.example.com:27017",
    });

    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "find", text: "{}" },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_UNREADABLE" });

    expect(prismaMock.projectDatabaseConnection.delete).toHaveBeenCalled();
  });

  it("never puts the query text in a log line", async () => {
    const { logger } = await import("../lib/logger.js");
    find.mockReturnValue({
      sort: vi.fn(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await expect(
      service.runMongoQuery(
        "p1",
        { collection: "orders", mode: "find", text: '{"ssn": "123-45-6789"}' },
        { readOnly: true },
      ),
    ).rejects.toThrow();

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain("123-45-6789");
  });
});

describe("inferCollectionSchema", () => {
  it("samples the collection and reports how many documents it saw", async () => {
    aggregate.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{ _id: 1, name: "a" }, { _id: 2 }]),
    });

    const schema = await service.inferCollectionSchema("p1", "shop", "orders");

    expect(aggregate.mock.calls[0]?.[0]).toEqual([{ $sample: { size: 300 } }]);
    expect(schema.sampled).toBe(2);
    expect(schema.fields.find((field) => field.name === "name")?.presence).toBe(0.5);
  });

  it("falls back to the database named in the connection string", async () => {
    aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });

    const schema = await service.inferCollectionSchema("p1", "", "orders");

    expect(db).toHaveBeenCalledWith("shop");
    expect(schema.database).toBe("shop");
  });
});

describe("listCollections", () => {
  it("lists the collections of the database in the connection string", async () => {
    listCollectionsFn.mockReturnValue({
      toArray: vi
        .fn()
        .mockResolvedValue([
          { name: "orders", type: "collection" },
          { name: "recent", type: "view" },
        ]),
    });

    expect(await service.listCollections("p1")).toEqual([
      { database: "shop", name: "orders", kind: "collection" },
      { database: "shop", name: "recent", kind: "view" },
    ]);
  });
});
