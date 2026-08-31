import { describe, expect, it } from "vitest";
import { MAX_PAGE_SIZE, PAGE_SIZE, pageRequest, toPage } from "@replit-clone/shared";

/** The two functions every list in this product now goes through.
 *
 *  The defect they close is not "lists are long". It is that an array cannot
 *  say "there is more", so three lists were silently truncated at a constant
 *  and a fourth had no bound at all. A truncated list that claims to be
 *  complete is worse than a short one that admits it is not, and §2.21 has
 *  already paid for that once: a filter applied after a capped read answers
 *  "nothing here" instead of failing.
 */

function rows(count: number): { id: string }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `r${String(index)}` }));
}

describe("what the caller asked for", () => {
  it("has a default, so a caller that asks for nothing gets a page", () => {
    expect(pageRequest({})).toEqual({ cursor: undefined, limit: PAGE_SIZE });
  });

  it("takes a number from a query string, which is a string", () => {
    expect(pageRequest({ limit: "10" }).limit).toBe(10);
  });

  /** A limit somebody can set is a limit somebody can set to a million, and
   *  the whole point of this change is that no request scans the table. */
  it("will not be talked above the maximum", () => {
    expect(pageRequest({ limit: 100_000 }).limit).toBe(MAX_PAGE_SIZE);
  });

  it("reads nonsense as the default rather than as an error", () => {
    // A list is not the place to teach anybody about numbers, and each of
    // these has a plausible reading that is worse: 0 rows, a negative take
    // that throws in the driver, or NaN passed to the database.
    for (const limit of ["abc", "-1", "0", "", null, undefined, {}]) {
      expect(pageRequest({ limit }).limit).toBe(PAGE_SIZE);
    }
  });

  it("ignores an empty cursor, which is what an absent query parameter is", () => {
    expect(pageRequest({ cursor: "" }).cursor).toBeUndefined();
    expect(pageRequest({ cursor: 42 }).cursor).toBeUndefined();
  });
});

describe("turning rows into a page", () => {
  /** Reading limit + 1 is what makes "is there another page" a fact. The
   *  alternatives are a second count query over the same table, or calling a
   *  full page the last one -- which gives a "show more" that loads nothing. */
  it("says there is more when one extra row came back", () => {
    const page = toPage(rows(11), 10);

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBe("r9");
  });

  it("does not offer a cursor when the rows ran out", () => {
    expect(toPage(rows(4), 10).nextCursor).toBeNull();
  });

  /** The boundary that decides whether the last page has a dead "show more"
   *  under it: exactly a page of rows and nothing after them. */
  it("treats an exactly-full page as the last one", () => {
    const page = toPage(rows(10), 10);

    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it("is fine with nothing at all", () => {
    expect(toPage([], 10)).toEqual({ items: [], nextCursor: null });
  });

  /** The extra row is read to answer a question, not to be shown. Returning
   *  it would put one row on two pages. */
  it("never hands back the row it only peeked at", () => {
    expect(toPage(rows(11), 10).items.map((row) => row.id)).not.toContain("r10");
  });
});
