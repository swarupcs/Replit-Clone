import { describe, expect, it } from "vitest";
import { CronError, nextRunOf, parseCron } from "./cron.js";

/** The cron parser and the next-fire calculation.
 *
 *  Worth this much testing because a scheduler is the one feature where being
 *  wrong is invisible. A job that fires an hour late, or twice, or never,
 *  produces no error anybody sees — the report simply does not arrive, and the
 *  first person to notice is the one who needed it.
 */
const AT = (iso: string) => new Date(iso);
const OF = (expr: string, from: string) => nextRunOf(expr, AT(from))?.toISOString();

describe("parsing", () => {
  it("takes the five ordinary fields", () => {
    const fields = parseCron("30 2 * * *");
    expect(fields.minute).toEqual(new Set([30]));
    expect(fields.hour).toEqual(new Set([2]));
    expect(fields.domRestricted).toBe(false);
    expect(fields.dowRestricted).toBe(false);
  });

  it("takes lists, ranges and steps", () => {
    expect(parseCron("0,30 * * * *").minute).toEqual(new Set([0, 30]));
    expect(parseCron("0 9-17 * * *").hour).toEqual(
      new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]),
    );
    expect(parseCron("*/15 * * * *").minute).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCron("0 0-12/6 * * *").hour).toEqual(new Set([0, 6, 12]));
  });

  it("reads n/s as 'from n onwards', the way crontab does", () => {
    expect(parseCron("5/20 * * * *").minute).toEqual(new Set([5, 25, 45]));
  });

  it("expands the shorthands", () => {
    expect(parseCron("@daily")).toMatchObject({
      minute: new Set([0]),
      hour: new Set([0]),
    });
    expect(parseCron("@weekly").dow).toEqual(new Set([0]));
    expect(parseCron("@monthly").dom).toEqual(new Set([1]));
  });

  it("is not case sensitive and tolerates surrounding space", () => {
    expect(parseCron("  @DAILY ")).toMatchObject({ hour: new Set([0]) });
    expect(parseCron("0    0  *  *  *").hour).toEqual(new Set([0]));
  });

  it("says which field is wrong, and how", () => {
    // A scheduled job is configured once and then not thought about. The
    // moment somebody learns they typed it wrong should be the moment they
    // typed it, not three weeks later when the report never arrived.
    expect(() => parseCron("0 0 * *")).toThrow(/five fields/i);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range for the minute/i);
    expect(() => parseCron("0 24 * * *")).toThrow(/out of range for the hour/i);
    expect(() => parseCron("0 0 0 * *")).toThrow(/day of month/i);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/month/i);
    expect(() => parseCron("0 0 * * 7")).toThrow(/day of week/i);
    expect(() => parseCron("x * * * *")).toThrow(/not a number/i);
    expect(() => parseCron("")).toThrow(/enter a schedule/i);
  });

  it("refuses a backwards range rather than guessing at a wrap", () => {
    // Some dialects wrap 22-2 around midnight and some reject it. Guessing
    // means an expression whose meaning depends on which library read it.
    expect(() => parseCron("0 22-2 * * *")).toThrow(/backwards/i);
  });

  it("refuses the dialects it does not implement", () => {
    for (const expr of ["0 0 L * *", "0 0 * * 1#2", "0 0 ? * *", "0 0 * * MON"]) {
      expect(() => parseCron(expr)).toThrow(CronError);
    }
  });

  it("refuses a step of zero", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/not a step/i);
  });
});

describe("the next run", () => {
  it("finds the next matching minute", () => {
    expect(OF("*/15 * * * *", "2026-08-30T10:07:00.000Z")).toBe(
      "2026-08-30T10:15:00.000Z",
    );
  });

  it("never returns the instant it was asked about", () => {
    // Otherwise a job re-fires forever at the moment it just ran: the runner
    // records lastRunAt, asks for the next run after it, and is handed the
    // same minute back.
    expect(OF("*/15 * * * *", "2026-08-30T10:15:00.000Z")).toBe(
      "2026-08-30T10:30:00.000Z",
    );
  });

  it("ignores seconds below the minute it starts from", () => {
    expect(OF("*/15 * * * *", "2026-08-30T10:14:59.999Z")).toBe(
      "2026-08-30T10:15:00.000Z",
    );
  });

  it("rolls into the next hour and the next day", () => {
    expect(OF("0 * * * *", "2026-08-30T10:30:00.000Z")).toBe(
      "2026-08-30T11:00:00.000Z",
    );
    expect(OF("@daily", "2026-08-30T10:30:00.000Z")).toBe(
      "2026-08-31T00:00:00.000Z",
    );
  });

  it("rolls across a month and a year", () => {
    expect(OF("@daily", "2026-12-31T10:30:00.000Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("honours a day of week", () => {
    // 2026-08-30 is a Sunday; the next Monday is the 31st.
    expect(OF("0 9 * * 1", "2026-08-30T10:00:00.000Z")).toBe(
      "2026-08-31T09:00:00.000Z",
    );
  });

  it("honours a day of month", () => {
    expect(OF("0 0 1 * *", "2026-08-30T10:00:00.000Z")).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // Cron's rule rather than this file's, and the one that surprises people.
    // From Sunday 2026-08-30, "the 1st or any Monday" is Monday the 31st --
    // not the 1st, which an AND reading would give.
    expect(OF("0 0 1 * 1", "2026-08-30T10:00:00.000Z")).toBe(
      "2026-08-31T00:00:00.000Z",
    );
  });

  it("uses only the restricted one when the other is *", () => {
    // The OR collapses, so the surprising case never arises for the
    // expressions people actually write.
    expect(OF("0 0 15 * *", "2026-08-30T10:00:00.000Z")).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });

  it("skips months the expression excludes", () => {
    expect(OF("0 0 1 1 *", "2026-08-30T10:00:00.000Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("finds a leap day years away", () => {
    // The worst legitimate case, and the reason the search is by day rather
    // than by minute: this is over three million minutes ahead.
    expect(OF("0 0 29 2 *", "2026-08-30T10:00:00.000Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("is null for an expression that parses but can never fire", () => {
    // `0 0 30 2 *` is well-formed and there is no 30th of February. The caller
    // has to handle it rather than assume a date came back.
    expect(nextRunOf("0 0 30 2 *", AT("2026-08-30T10:00:00.000Z"))).toBeNull();
  });

  it("is stable when applied to its own answer", () => {
    // The property the scheduler depends on: advancing from a fire time lands
    // on the following one, never on the same one and never skipping one.
    let at = AT("2026-08-30T00:00:00.000Z");
    const seen: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const next = nextRunOf("*/20 * * * *", at);
      expect(next).not.toBeNull();
      at = next!;
      seen.push(at.toISOString());
    }

    expect(seen).toEqual([
      "2026-08-30T00:20:00.000Z",
      "2026-08-30T00:40:00.000Z",
      "2026-08-30T01:00:00.000Z",
      "2026-08-30T01:20:00.000Z",
      "2026-08-30T01:40:00.000Z",
    ]);
  });
});
