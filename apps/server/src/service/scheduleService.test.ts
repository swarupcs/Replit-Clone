import { describe, expect, it } from "vitest";
import { validateSchedule } from "./scheduleService.js";
import { BadRequestError } from "../utils/errors.js";

/** What a schedule is allowed to be, before any of it reaches a database.
 *
 *  `validateSchedule` is the only place that turns a string somebody typed
 *  into a commitment to start a container later, so the three ways of getting
 *  it wrong are three different messages rather than one. A person who typed
 *  `0 0 31 2 *` and is told "invalid schedule" cannot tell that their
 *  expression is fine and their date does not exist.
 */
const NOW = new Date("2026-08-30T10:15:00.000Z");

function reason(expression: string): string {
  try {
    validateSchedule(expression, NOW);
  } catch (error) {
    if (error instanceof BadRequestError) return error.code;
    throw error;
  }

  throw new Error(`"${expression}" was accepted`);
}

describe("accepting a schedule", () => {
  it("answers with the next firing, in UTC", () => {
    expect(validateSchedule("30 2 * * *", NOW)?.toISOString()).toBe(
      "2026-08-31T02:30:00.000Z",
    );
  });

  it("takes the shorthands", () => {
    expect(validateSchedule("@daily", NOW)?.toISOString()).toBe(
      "2026-08-31T00:00:00.000Z",
    );
  });

  /** The next firing is computed from the instant given, not from midnight or
   *  from the process's own clock — a job saved at 10:15 for "every hour" is
   *  due at 11:00, and a version that answered 00:00 would fire it
   *  immediately and then look correct forever after. */
  it("computes from the instant it was given", () => {
    expect(validateSchedule("0 * * * *", NOW)?.toISOString()).toBe(
      "2026-08-30T11:00:00.000Z",
    );
  });
});

describe("refusing a schedule", () => {
  it("says which field will not parse", () => {
    expect(reason("0 0 * * funday")).toBe("BAD_SCHEDULE");

    try {
      validateSchedule("0 0 * * funday", NOW);
    } catch (error) {
      expect((error as Error).message).toContain("day of week");
    }
  });

  it("refuses a five-field expression that is not five fields", () => {
    expect(reason("0 0 * *")).toBe("BAD_SCHEDULE");
  });

  /** Valid cron for a date that does not exist. It parses, it stores, and it
   *  never fires — so a job saved from it would sit in the list looking
   *  scheduled forever. Told at the moment it is typed instead. */
  it("refuses a schedule that never happens", () => {
    expect(reason("0 0 30 2 *")).toBe("SCHEDULE_NEVER_FIRES");
  });

  /** Not because the expression is wrong. Because this platform's unit of
   *  work is a container, and one per minute forever is a cost model nothing
   *  here was built for. */
  it("refuses one that fires every minute", () => {
    expect(reason("* * * * *")).toBe("SCHEDULE_TOO_FREQUENT");
  });

  it("refuses one that fires more often than the floor, written another way", () => {
    expect(reason("*/2 * * * *")).toBe("SCHEDULE_TOO_FREQUENT");
    // Comma lists are the shape a frequency check based on the expression's
    // *form* would miss: neither term is a step, and the gap is one minute.
    expect(reason("0,1 * * * *")).toBe("SCHEDULE_TOO_FREQUENT");
  });

  it("accepts one exactly at the floor", () => {
    expect(validateSchedule("*/5 * * * *", NOW)?.toISOString()).toBe(
      "2026-08-30T10:20:00.000Z",
    );
  });

  it("refuses an empty schedule", () => {
    expect(reason("   ")).toBe("BAD_SCHEDULE");
  });
});
