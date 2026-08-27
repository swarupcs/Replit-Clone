/** Postgres type oids the grid renders specially.
 *
 *  Only the ones where the default rendering is actively misleading. */
const JSON_OIDS = new Set([114, 3802]);
const BYTEA_OID = 17;
const BOOL_OID = 16;

export interface RenderedCell {
  text: string;
  /** How to style it. `null` is deliberately its own kind: telling a NULL
   *  apart from an empty string is most of what a data grid is for, and
   *  rendering both as "" is the single most common way a grid lies. */
  kind: "null" | "json" | "binary" | "boolean" | "number" | "text";
}

export function renderCell(value: unknown, dataTypeId?: number): RenderedCell {
  if (value === null || value === undefined) {
    return { text: "NULL", kind: "null" };
  }

  if (dataTypeId === BYTEA_OID || value instanceof Uint8Array) {
    const bytes =
      value instanceof Uint8Array
        ? value.byteLength
        : typeof value === "string"
          ? Math.max(0, (value.length - 2) / 2)
          : 0;
    // A size, not the bytes: a megabyte of binary pasted into a cell helps
    // nobody and freezes the grid.
    return { text: `${bytes} bytes`, kind: "binary" };
  }

  if (dataTypeId !== undefined && JSON_OIDS.has(dataTypeId)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { text, kind: "json" };
  }

  if (dataTypeId === BOOL_OID || typeof value === "boolean") {
    return { text: value ? "true" : "false", kind: "boolean" };
  }

  if (value instanceof Date) {
    // ISO, offset kept: a timestamp without its timezone is a different
    // instant depending on who reads it.
    return { text: value.toISOString(), kind: "text" };
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return { text: String(value), kind: "number" };
  }

  // Strings come through as they are, timestamps included: Postgres already
  // formats a timestamptz with its offset, and reformatting it here would
  // only risk losing that.
  if (typeof value === "string") return { text: value, kind: "text" };

  // Anything left is an object of some kind. Serialising it beats
  // `String(value)`, which would render the whole cell as "[object Object]"
  // and hide the value entirely.
  return { text: JSON.stringify(value) ?? "", kind: "json" };
}
