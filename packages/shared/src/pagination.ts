/** One page of a list, and whether there is another.
 *
 *  Every list in this product used to answer with an array, and an array is
 *  the one shape that cannot say "there is more". Three of them were silently
 *  truncated at a constant — 200 reports, 100 moderation actions, 50 public
 *  projects — and the fourth had no cap at all, so the two failure modes were
 *  a list that lies about being complete and a query with no bound on it.
 *
 *  **A truncated list that says it is complete is worse than a short one that
 *  says it is not.** §2.21 has already shown what the first kind costs: a
 *  filter applied after a capped query reads as "nothing here" rather than
 *  failing, and only luck put the cap in view.
 */
export interface Page<T> {
  items: T[];
  /** The id to pass back as `cursor` for the next page, or null when this is
   *  the last one. Opaque on purpose: it is a row id today and callers that
   *  parse it will break when it stops being one. */
  nextCursor: string | null;
}

/** Rows per page when the caller does not say.
 *
 *  Chosen to be more than any of these screens shows at once, so the common
 *  case is one request and the pagination is machinery nobody has to notice.
 */
export const PAGE_SIZE = 50;

/** The most a caller may ask for in one request. A limit somebody can set is
 *  a limit somebody can set to a million. */
export const MAX_PAGE_SIZE = 100;

/** A cursor and a size, from whatever the caller sent.
 *
 *  Query strings are strings, and a `limit` of "abc", "-1" or "1e9" all have
 *  to mean something. Here they all mean the default, because a list is not
 *  the place to teach people about numbers.
 */
export function pageRequest(input: {
  cursor?: unknown;
  limit?: unknown;
}): { cursor: string | undefined; limit: number } {
  const asked = Number(input.limit);
  const limit =
    Number.isFinite(asked) && asked >= 1
      ? Math.min(Math.floor(asked), MAX_PAGE_SIZE)
      : PAGE_SIZE;

  const cursor =
    typeof input.cursor === "string" && input.cursor.length > 0
      ? input.cursor
      : undefined;

  return { cursor, limit };
}

/** Turns one row more than was asked for into a page and a cursor.
 *
 *  Reading `limit + 1` is what makes "is there another page" a fact rather
 *  than a guess. The alternative — a count query, or calling a full page the
 *  last one — is either a second scan of the same table or a "load more" that
 *  sometimes loads nothing.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };

  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]?.id ?? null };
}
