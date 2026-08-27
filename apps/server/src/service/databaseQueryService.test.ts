import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, connect, release, poolEnd, PoolCtor } = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const connect = vi.fn();
  const poolEnd = vi.fn().mockResolvedValue(undefined);
  const PoolCtor = vi.fn();
  return { query, connect, release, poolEnd, PoolCtor };
});

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      PoolCtor(options);
    }
    connect = connect;
    end = poolEnd;
    on = vi.fn();
  },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    projectDatabaseConnection: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("../lib/prisma.js", () => ({ prisma: prismaMock }));

// Opaque on purpose. A double that returns `sealed:<plaintext>` would let
// an assertion that the ciphertext does not contain the password pass or
// fail on a property of the double rather than of the code.
vi.mock("../lib/secretBox.js", () => ({
  seal: (value: string) => `v1.${Buffer.from(value).toString("base64url")}`,
  open: (value: string) => {
    if (!value.startsWith("v1.")) throw new Error("cannot open");
    return Buffer.from(value.slice(3), "base64url").toString();
  },
}));

const { checkConnectionString, checkMongoConnectionString } = vi.hoisted(() => ({
  checkConnectionString: vi.fn(),
  checkMongoConnectionString: vi.fn(),
}));
vi.mock("../lib/connectionGuard.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkConnectionString,
  checkMongoConnectionString,
}));

const service = await import("./databaseQueryService.js");

const CHECKED = {
  url: "postgresql://u:p@db.example.com:5432/app",
  scheme: "postgresql" as const,
  host: "db.example.com",
  port: 5432,
  address: "93.184.216.34",
};

describe("storing a connection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    checkConnectionString.mockResolvedValue(CHECKED);
    await service.closeAllPools();
  });

  /** The check lives inside the service rather than at the edge so there is
   *  no route into storage that skips it. */
  it("checks the string before storing it", async () => {
    await service.setConnection("p1", CHECKED.url);
    expect(checkConnectionString).toHaveBeenCalledWith(CHECKED.url);
  });

  it("stores it sealed, never in the clear", async () => {
    await service.setConnection("p1", CHECKED.url);

    const stored = prismaMock.projectDatabaseConnection.upsert.mock.calls[0]?.[0];
    expect(stored.create.urlCipher).not.toContain(CHECKED.url);
    expect(JSON.stringify(stored)).not.toContain("u:p@");
  });

  it("keeps the password out of the label", async () => {
    await service.setConnection("p1", CHECKED.url);
    const stored = prismaMock.projectDatabaseConnection.upsert.mock.calls[0]?.[0];
    expect(stored.create.label).toBe("db.example.com:5432");
  });

  it("refuses a string the guard rejected", async () => {
    checkConnectionString.mockRejectedValue(new Error("refused"));
    await expect(service.setConnection("p1", "postgresql://x")).rejects.toThrow();
    expect(prismaMock.projectDatabaseConnection.upsert).not.toHaveBeenCalled();
  });

  it("checks a Mongo string with the Mongo guard, not the Postgres one", async () => {
    // Not interchangeable: `new URL` cannot parse a Mongo seed list at all,
    // so running the Postgres check over one would refuse every replica set
    // as malformed.
    checkMongoConnectionString.mockResolvedValue({
      url: "mongodb://a.example.com,b.example.com/shop",
      scheme: "mongodb",
      srv: false,
      hosts: [],
      label: "a.example.com:27017,b.example.com:27017",
    });

    const stored = await service.setConnection(
      "p1",
      "mongodb://a.example.com,b.example.com/shop",
    );

    expect(checkConnectionString).not.toHaveBeenCalled();
    expect(stored).toEqual({
      engine: "mongodb",
      label: "a.example.com:27017,b.example.com:27017",
    });
  });

  it("refuses a Mongo string the Mongo guard rejected", async () => {
    checkMongoConnectionString.mockRejectedValue(new Error("refused"));
    await expect(service.setConnection("p1", "mongodb://x")).rejects.toThrow();
    expect(prismaMock.projectDatabaseConnection.upsert).not.toHaveBeenCalled();
  });

  it("refuses to run SQL against a stored Mongo connection", async () => {
    // `pg` would take the mongodb:// string and fail with something about a
    // password, which is a worse answer than the true one.
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
      projectId: "p1",
      engine: "mongodb",
      urlCipher: `v1.${Buffer.from("mongodb://h/shop").toString("base64url")}`,
      label: "h:27017",
    });

    await expect(
      service.runQuery("p1", "SELECT 1", { readOnly: true }),
    ).rejects.toMatchObject({ code: "ENGINE_MISMATCH" });
  });
});

describe("running a query", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await service.closeAllPools();
    checkConnectionString.mockResolvedValue(CHECKED);
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
      urlCipher: `v1.${Buffer.from(CHECKED.url).toString("base64url")}`,
      engine: "postgresql",
      label: "db.example.com:5432",
    });
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [], fields: [], rowCount: 0 });
  });

  /** §7.5: classification may warn and must never permit. A viewer's session
   *  is read-only because the database says so. */
  it("runs a viewer's statement inside a read-only transaction", async () => {
    await service.runQuery("p1", "SELECT 1", { readOnly: true });
    expect(query).toHaveBeenCalledWith("BEGIN READ ONLY");
  });

  it("runs an editor's statement in an ordinary transaction", async () => {
    await service.runQuery("p1", "UPDATE t SET x = 1", { readOnly: false });
    expect(query).toHaveBeenCalledWith("BEGIN");
  });

  it("sets a statement timeout on every session", async () => {
    await service.runQuery("p1", "SELECT 1", { readOnly: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("statement_timeout"));
  });

  it("connects to the address the guard approved, not the hostname", async () => {
    await service.runQuery("p1", "SELECT 1", { readOnly: true });
    expect(PoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({ host: "93.184.216.34" }),
    );
  });

  /** DNS moves. A name that was public when it was stored can point at
   *  loopback today, so the guard runs again on every pool creation. */
  it("re-checks the stored string rather than trusting it", async () => {
    await service.runQuery("p1", "SELECT 1", { readOnly: true });
    expect(checkConnectionString).toHaveBeenCalledWith(CHECKED.url);
  });

  it("caps the rows it returns", async () => {
    const many = Array.from({ length: 5000 }, (_, index) => [index]);
    query.mockImplementation((arg: unknown) =>
      typeof arg === "object"
        ? Promise.resolve({ rows: many, fields: [{ name: "n", dataTypeID: 23 }], rowCount: many.length })
        : Promise.resolve({}),
    );

    const result = await service.runQuery("p1", "SELECT 1", { readOnly: true });
    expect(result.rows).toHaveLength(service.ROW_CAP);
    // Said out loud, so the UI does not show part of an answer as if it were
    // all of it.
    expect(result.truncated).toBe(true);
  });

  it("rolls back when a statement fails", async () => {
    query.mockImplementation((arg: unknown) =>
      typeof arg === "object"
        ? Promise.reject(new Error("syntax error"))
        : Promise.resolve({}),
    );

    await expect(
      service.runQuery("p1", "SELEC 1", { readOnly: true }),
    ).rejects.toThrow(/syntax error/);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("redacts credentials out of an error message", async () => {
    query.mockImplementation((arg: unknown) =>
      typeof arg === "object"
        ? Promise.reject(
            new Error("could not connect to postgresql://user:hunter2@db.example.com/app"),
          )
        : Promise.resolve({}),
    );

    await expect(service.runQuery("p1", "SELECT 1", { readOnly: true })).rejects.toThrow(
      /\*\*\*@db\.example\.com/,
    );
  });

  it("says so when no connection has been set", async () => {
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue(null);
    await expect(
      service.runQuery("p2", "SELECT 1", { readOnly: true }),
    ).rejects.toThrow(/no database connection/i);
  });

  /** A key rotation leaves rows that can never be opened; keeping one only
   *  guarantees a failure on every future query. */
  it("drops a connection it can no longer decrypt", async () => {
    prismaMock.projectDatabaseConnection.findUnique.mockResolvedValue({
      urlCipher: "garbage",
      engine: "postgresql",
      label: "x",
    });

    await expect(
      service.runQuery("p3", "SELECT 1", { readOnly: true }),
    ).rejects.toThrow(/could not be read/);
    expect(prismaMock.projectDatabaseConnection.delete).toHaveBeenCalled();
  });

  it("reuses one pool per project rather than one per query", async () => {
    await service.runQuery("p1", "SELECT 1", { readOnly: true });
    await service.runQuery("p1", "SELECT 2", { readOnly: true });
    expect(PoolCtor).toHaveBeenCalledTimes(1);
  });

  it("always releases the client, even when the statement threw", async () => {
    query.mockImplementation((arg: unknown) =>
      typeof arg === "object" ? Promise.reject(new Error("boom")) : Promise.resolve({}),
    );
    await expect(
      service.runQuery("p1", "SELECT 1", { readOnly: true }),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalled();
  });
});

describe("groupIntrospection", () => {
  it("groups columns under their table", () => {
    expect(
      service.groupIntrospection([
        ["public", "users", "BASE TABLE", "id", "uuid", "NO", true],
        ["public", "users", "BASE TABLE", "email", "text", "NO", false],
      ]),
    ).toEqual([
      {
        schema: "public",
        name: "users",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true },
          { name: "email", dataType: "text", nullable: false, isPrimaryKey: false },
        ],
      },
    ]);
  });

  it("tells a view from a table", () => {
    const [table] = service.groupIntrospection([
      ["public", "active", "VIEW", "id", "uuid", "YES", false],
    ]);
    expect(table?.kind).toBe("view");
  });

  /** Two schemas can hold a table of the same name, and flattening them
   *  together would merge one table's columns into another's. */
  it("keeps same-named tables in different schemas apart", () => {
    expect(
      service.groupIntrospection([
        ["public", "users", "BASE TABLE", "id", "uuid", "NO", true],
        ["audit", "users", "BASE TABLE", "at", "timestamp", "NO", false],
      ]),
    ).toHaveLength(2);
  });

  it("reads nullability as a boolean rather than a string", () => {
    const [table] = service.groupIntrospection([
      ["public", "t", "BASE TABLE", "c", "text", "YES", false],
    ]);
    expect(table?.columns[0]?.nullable).toBe(true);
  });
});
