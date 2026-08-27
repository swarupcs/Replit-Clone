import { describe, expect, it } from "vitest";
import {
  completionsFor,
  expectsTable,
  tableInScope,
} from "./sqlCompletion.ts";
import type { IntrospectedTable } from "../apis/projects.ts";

const tables: IntrospectedTable[] = [
  {
    schema: "public",
    name: "users",
    kind: "table",
    columns: [
      { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true },
      { name: "email", dataType: "text", nullable: false, isPrimaryKey: false },
    ],
  },
  {
    schema: "audit",
    name: "events",
    kind: "view",
    columns: [
      { name: "at", dataType: "timestamptz", nullable: true, isPrimaryKey: false },
    ],
  },
];

describe("expectsTable", () => {
  it.each(["SELECT * FROM ", "select * from us", "JOIN ", "UPDATE ", "INSERT INTO "])(
    "is true after %j",
    (text) => {
      expect(expectsTable(text)).toBe(true);
    },
  );

  it("is false in the middle of a select list", () => {
    expect(expectsTable("SELECT id, ")).toBe(false);
  });

  it("is false once the table is named and a space follows", () => {
    expect(expectsTable("SELECT * FROM users ")).toBe(false);
  });
});

describe("tableInScope", () => {
  it("finds the table after FROM", () => {
    expect(tableInScope("SELECT * FROM users WHERE ")).toBe("users");
  });

  it("prefers the most recent one, which is what is being typed", () => {
    expect(tableInScope("SELECT * FROM users JOIN events ON ")).toBe("events");
  });

  it("takes the table out of a qualified name", () => {
    expect(tableInScope("SELECT * FROM audit.events WHERE ")).toBe("events");
  });

  it("reads a quoted identifier", () => {
    expect(tableInScope('SELECT * FROM "odd name" WHERE ')).toBe("odd name");
  });

  it("finds nothing when no table has been named", () => {
    expect(tableInScope("SELECT ")).toBeNull();
  });
});

describe("completionsFor", () => {
  it("offers tables where a table belongs", () => {
    const items = completionsFor("SELECT * FROM ", tables);
    expect(items.map((item) => item.label)).toEqual(["users", "audit.events"]);
    expect(items.every((item) => item.kind === "table")).toBe(true);
  });

  /** A table outside `public` is only reachable by its qualified name, so
   *  offering the bare name would complete to something that does not
   *  resolve. */
  it("qualifies a table outside the public schema", () => {
    expect(completionsFor("FROM ", tables).map((item) => item.label)).toContain(
      "audit.events",
    );
  });

  it("offers that table's columns once it is named", () => {
    const items = completionsFor("SELECT * FROM users WHERE ", tables);
    expect(items.map((item) => item.label)).toEqual(["id", "email"]);
    expect(items.every((item) => item.kind === "column")).toBe(true);
  });

  it("says what a column is, which is why the detail is worth carrying", () => {
    const [id] = completionsFor("SELECT * FROM users WHERE ", tables);
    expect(id?.detail).toBe("uuid · primary key · not null");
  });

  it("marks a view as a view", () => {
    const items = completionsFor("SELECT * FROM ", tables);
    expect(items.find((item) => item.label === "audit.events")?.detail).toBe("view");
  });

  it("falls back to tables when the named one is unknown", () => {
    expect(
      completionsFor("SELECT * FROM nonexistent WHERE ", tables).every(
        (item) => item.kind === "table",
      ),
    ).toBe(true);
  });

  it("offers something rather than nothing on a bare SELECT", () => {
    expect(completionsFor("SELECT ", tables).length).toBeGreaterThan(0);
  });
});
