/** Rendering EJSON documents, which is not the same problem as rendering rows.
 *
 *  A Postgres value arrives already typed by an oid. A Mongo value arrives as
 *  relaxed EJSON, where the type is carried *inside* the value — `_id` is
 *  `{"$oid": "…"}` and a date is `{"$date": "…"}`. Rendering those as objects
 *  would show `{"$oid":"651f…"}` in every row of every collection, which is
 *  the noisiest possible way to display the one field every document has.
 */

export interface RenderedValue {
  text: string;
  kind: "null" | "objectid" | "date" | "number" | "boolean" | "text" | "array" | "object";
}

/** The EJSON wrappers worth unwrapping, and what to call them.
 *
 *  Deliberately not every wrapper: `$binary` stays an object so it renders as
 *  a size rather than as a wall of base64. */
const WRAPPERS: Record<string, RenderedValue["kind"]> = {
  $oid: "objectid",
  $date: "date",
  $numberDecimal: "number",
  $numberLong: "number",
  $numberDouble: "number",
  $numberInt: "number",
};

/** The single EJSON wrapper key of an object, if that is all it is. */
function wrapperOf(value: object): { key: string; inner: unknown } | undefined {
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || !key || !(key in WRAPPERS)) return undefined;
  return { key, inner: (value as Record<string, unknown>)[key] };
}

export function renderValue(value: unknown): RenderedValue {
  // `undefined` and `null` are one kind here, unlike Postgres: a missing
  // field and a null field are both "not a value", and Mongo tells them
  // apart by the field's absence rather than by its contents.
  if (value === null || value === undefined) return { text: "null", kind: "null" };

  if (typeof value === "boolean") {
    return { text: value ? "true" : "false", kind: "boolean" };
  }
  if (typeof value === "number") return { text: String(value), kind: "number" };
  if (typeof value === "string") return { text: value, kind: "text" };

  if (Array.isArray(value)) {
    return {
      text: `[${value.length} item${value.length === 1 ? "" : "s"}]`,
      kind: "array",
    };
  }

  if (typeof value === "object") {
    const wrapper = wrapperOf(value);
    if (wrapper) {
      const kind = WRAPPERS[wrapper.key] ?? "text";
      if (wrapper.key === "$date") {
        // A `$date` is an ISO string in relaxed mode and a `$numberLong` in
        // canonical mode. Both are shown as the ISO instant, offset kept: a
        // timestamp without its timezone is a different instant per reader.
        const inner = wrapper.inner;
        const iso =
          typeof inner === "string"
            ? inner
            : new Date(Number((inner as { $numberLong?: string })?.$numberLong ?? 0))
                .toISOString();
        return { text: iso, kind: "date" };
      }
      return { text: String(wrapper.inner), kind };
    }

    const keys = Object.keys(value);
    return {
      text: `{${keys.length} field${keys.length === 1 ? "" : "s"}}`,
      kind: "object",
    };
  }

  // Everything JSON.parse can produce is handled above; what is left is a
  // bigint, symbol or function, which only arrive if a caller hands this
  // something that did not come off the wire.
  if (typeof value === "bigint") return { text: value.toString(), kind: "number" };
  return { text: JSON.stringify(value) ?? "", kind: "text" };
}

/** A one-line preview of a whole document, for the collapsed header of the
 *  detail list — enough to tell two documents apart without expanding both. */
export function summariseDocument(document: unknown, limit = 3): string {
  if (document === null || typeof document !== "object") {
    return renderValue(document).text;
  }

  const entries = Object.entries(document as Record<string, unknown>);
  const shown = entries
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${renderValue(value).text}`)
    .join(", ");

  const rest = entries.length - Math.min(limit, entries.length);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/** How a field's inferred presence reads to a person.
 *
 *  A percentage rather than a bar: "in 12% of sampled documents" is a claim
 *  someone can act on, and a bar is a claim nobody can read off precisely. */
export function presenceLabel(presence: number): string {
  const percent = Math.round(presence * 100);
  return percent >= 100 ? "in every sampled document" : `in ${percent}% of the sample`;
}
