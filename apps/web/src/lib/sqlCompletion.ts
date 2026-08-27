import type { IntrospectedTable } from "../apis/projects.ts";

export interface CompletionItem {
  label: string;
  detail: string;
  /** "table" or "column", so the caller can pick a Monaco completion kind
   *  without this module importing Monaco. */
  kind: "table" | "column";
}

/** The identifier immediately before the cursor that names a table.
 *
 *  Deliberately crude: the last `FROM`, `JOIN`, `UPDATE` or `INTO` before the
 *  cursor. A real parser would be better and is not worth it here — the
 *  question is only "which table's columns should be offered", and the last
 *  table named is very nearly always the right answer while typing.
 */
export function tableInScope(textBeforeCursor: string): string | null {
  const matches = [
    ...textBeforeCursor.matchAll(
      /\b(?:from|join|update|into)\s+(?:"([^"]+)"|([a-zA-Z_][\w$]*))(?:\.(?:"([^"]+)"|([a-zA-Z_][\w$]*)))?/gi,
    ),
  ];
  const last = matches[matches.length - 1];
  if (!last) return null;

  // A qualified name (schema.table) puts the table in the second pair.
  const qualified = last[3] ?? last[4];
  return qualified ?? last[1] ?? last[2] ?? null;
}

/** True when the cursor sits where a table name belongs. */
export function expectsTable(textBeforeCursor: string): boolean {
  return /\b(?:from|join|update|into)\s+[\w"$.]*$/i.test(textBeforeCursor);
}

/** What to offer at the cursor.
 *
 *  §7.6 calls this the detail that makes the editor feel finished rather than
 *  merely functional, and it is a day's work on data already fetched for the
 *  tree — which is the whole argument for doing it.
 */
export function completionsFor(
  textBeforeCursor: string,
  tables: IntrospectedTable[],
): CompletionItem[] {
  if (expectsTable(textBeforeCursor)) {
    return tables.map((table) => ({
      label: table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
      detail: table.kind === "view" ? "view" : `${table.columns.length} columns`,
      kind: "table" as const,
    }));
  }

  const scoped = tableInScope(textBeforeCursor);
  if (scoped) {
    const table = tables.find(
      (candidate) => candidate.name.toLowerCase() === scoped.toLowerCase(),
    );
    if (table) {
      return table.columns.map((column) => ({
        label: column.name,
        detail: `${column.dataType}${column.isPrimaryKey ? " · primary key" : ""}${
          column.nullable ? "" : " · not null"
        }`,
        kind: "column" as const,
      }));
    }
  }

  // Nothing named yet: every table, so `SELECT ` still offers something
  // rather than nothing.
  return tables.map((table) => ({
    label: table.schema === "public" ? table.name : `${table.schema}.${table.name}`,
    detail: table.kind === "view" ? "view" : `${table.columns.length} columns`,
    kind: "table" as const,
  }));
}
