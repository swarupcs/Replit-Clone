/** A five-field cron expression, and when it next fires.
 *
 *  Written rather than depended on, for the same reason the LSP client was: a
 *  scheduler needs exactly one thing from a cron library — "given this
 *  expression and this instant, what is the next instant" — and every library
 *  that answers it also brings a timezone database, a job runner and an
 *  opinion about how jobs are stored. This is the answer without the rest.
 *
 *  **Everything here is UTC.** Not because local time is wrong, but because
 *  local time is a promise this cannot keep: a server that moves between
 *  regions, or a daylight-saving boundary, turns "runs at 02:30 daily" into a
 *  day with two of them and a day with none. A job that says UTC and means it
 *  is honest; one that says 02:30 and silently means something else twice a
 *  year is the bug people file in April.
 *
 *  Supported: `*`, `n`, `a-b`, `a-b/s`, `* / s`, and comma-separated lists of
 *  those. Plus the `@hourly` / `@daily` / `@weekly` / `@monthly` shorthands,
 *  which is what most people actually want and cannot get wrong. Not
 *  supported: `L`, `W`, `#`, `?`, second-level precision and named months —
 *  each is a dialect rather than cron, and accepting one silently would mean
 *  accepting an expression whose meaning depends on which library reads it.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  /** Day of month, 1-31. */
  dom: Set<number>;
  /** Month, 1-12. */
  month: Set<number>;
  /** Day of week, 0-6, Sunday first. */
  dow: Set<number>;
  /** Whether day-of-month was restricted, i.e. was anything but `*`. Kept
   *  because the cron day rule depends on it — see `matchesDay`. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronError extends Error {}

const SHORTHAND: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface Bounds {
  min: number;
  max: number;
  label: string;
}

const FIELDS: Bounds[] = [
  { min: 0, max: 59, label: "minute" },
  { min: 0, max: 23, label: "hour" },
  { min: 1, max: 31, label: "day of month" },
  { min: 1, max: 12, label: "month" },
  { min: 0, max: 6, label: "day of week" },
];

/** Parses an expression, or explains why it will not parse.
 *
 *  The errors name the field and say what was wrong with it, because a
 *  scheduled job is configured once and then not thought about again — the
 *  moment somebody finds out they typed it wrong should be the moment they
 *  typed it, not three weeks later when the report they expected never
 *  arrived.
 */
export function parseCron(raw: string): CronFields {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) throw new CronError("Enter a schedule.");

  const expanded = SHORTHAND[trimmed] ?? trimmed;
  const parts = expanded.split(/\s+/);

  if (parts.length !== 5) {
    throw new CronError(
      `A schedule has five fields — minute, hour, day of month, month, day ` +
        `of week — and this has ${String(parts.length)}.`,
    );
  }

  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));

  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function parseField(field: string, bounds: Bounds): Set<number> {
  const values = new Set<number>();

  for (const term of field.split(",")) {
    if (term.length === 0) {
      throw new CronError(`Empty value in the ${bounds.label} field.`);
    }

    const [rangePart, stepPart, ...extra] = term.split("/");

    if (extra.length > 0) {
      throw new CronError(
        `Only one step is allowed per value in the ${bounds.label} field.`,
      );
    }

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(
          `"${stepPart}" is not a step in the ${bounds.label} field.`,
        );
      }
    }

    const { from, to } = parseRange(rangePart ?? "", bounds, stepPart !== undefined);

    for (let value = from; value <= to; value += step) values.add(value);
  }

  // Reachable through a range whose step steps past its own end -- `10-12/5`
  // yields only 10, but `10-12/5` on a field starting above `to` yields
  // nothing at all. An empty set would match no instant and the scheduler
  // would look for a next run until it gave up, so it is refused here.
  if (values.size === 0) {
    throw new CronError(`Nothing matches in the ${bounds.label} field.`);
  }

  return values;
}

function parseRange(
  part: string,
  bounds: Bounds,
  hasStep: boolean,
): { from: number; to: number } {
  if (part === "*") return { from: bounds.min, to: bounds.max };

  const dash = part.indexOf("-");

  if (dash === -1) {
    const value = toNumber(part, bounds);
    // `5/10` means "from 5 onwards, every 10" — the same reading crontab has.
    // Without a step it is the single value 5.
    return { from: value, to: hasStep ? bounds.max : value };
  }

  const from = toNumber(part.slice(0, dash), bounds);
  const to = toNumber(part.slice(dash + 1), bounds);

  if (from > to) {
    throw new CronError(
      `The ${bounds.label} range ${part} runs backwards. Wrapping ranges are ` +
        `not supported; write it as two values separated by a comma.`,
    );
  }

  return { from, to };
}

function toNumber(text: string, bounds: Bounds): number {
  // `Number("")` is 0 and `Number(" 7 ")` is 7, both of which would let a
  // malformed field through as something that looks deliberate.
  if (!/^\d+$/.test(text)) {
    throw new CronError(`"${text}" is not a number in the ${bounds.label} field.`);
  }

  const value = Number(text);
  if (value < bounds.min || value > bounds.max) {
    throw new CronError(
      `${text} is out of range for the ${bounds.label} field ` +
        `(${String(bounds.min)}–${String(bounds.max)}).`,
    );
  }

  return value;
}

/** Whether a date's day satisfies the expression.
 *
 *  The rule that surprises people, and it is cron's rather than this file's:
 *  when BOTH day-of-month and day-of-week are restricted they are OR'd, not
 *  AND'd. `0 0 1 * 1` is the first of the month *and also* every Monday. When
 *  only one is restricted the other is `*` and matches everything, so the OR
 *  collapses to the restricted one and the surprising case never arises.
 */
function matchesDay(fields: CronFields, date: Date): boolean {
  const dom = fields.dom.has(date.getUTCDate());
  const dow = fields.dow.has(date.getUTCDay());

  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/** How far ahead to look before giving up.
 *
 *  `0 0 29 2 *` — the 29th of February — is the worst legitimate case, and it
 *  can be eight years away. Beyond that an expression matches nothing
 *  reachable (`0 0 30 2 *`), and the caller needs an answer rather than a
 *  loop.
 */
const MAX_DAYS_AHEAD = 366 * 9;

/** The first instant at or after `after` that the expression matches.
 *
 *  Searches by day and then within the day, rather than minute by minute: a
 *  yearly expression is four million minutes away and a per-minute scan for it
 *  is a scheduler that stops scheduling.
 *
 *  Returns null when nothing matches inside the horizon, which callers must
 *  handle rather than assume away — `0 0 30 2 *` parses cleanly and will never
 *  fire.
 */
export function nextRun(fields: CronFields, after: Date): Date | null {
  // Cron has minute resolution, so the search starts at the next whole minute.
  // Starting at `after` itself would re-fire a job at the instant it just ran.
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const minutes = sorted(fields.minute);
  const hours = sorted(fields.hour);

  for (let dayOffset = 0; dayOffset <= MAX_DAYS_AHEAD; dayOffset += 1) {
    const day = new Date(start.getTime());
    day.setUTCDate(day.getUTCDate() + dayOffset);

    if (!fields.month.has(day.getUTCMonth() + 1)) continue;
    if (!matchesDay(fields, day)) continue;

    // Only the first day of the search is constrained by the clock; every day
    // after it starts at midnight.
    const sameDay = dayOffset === 0;

    for (const hour of hours) {
      if (sameDay && hour < start.getUTCHours()) continue;

      for (const minute of minutes) {
        if (sameDay && hour === start.getUTCHours() && minute < start.getUTCMinutes()) {
          continue;
        }

        return new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            hour,
            minute,
          ),
        );
      }
    }
  }

  return null;
}

function sorted(values: Set<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Parses and computes in one step, for callers that have a string.
 *
 *  Throws `CronError` for an unparseable expression and returns null for one
 *  that parses but never fires — two different problems, and a caller that
 *  conflates them tells a user their valid expression is invalid.
 */
export function nextRunOf(expression: string, after: Date): Date | null {
  return nextRun(parseCron(expression), after);
}
