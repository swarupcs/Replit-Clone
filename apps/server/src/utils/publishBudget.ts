import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

/** Whether a visibility change counts against the publishing budget.
 *
 *  Its own module, and its own function, for one reason: the asymmetry below
 *  is the whole design, and a predicate buried in a `rateLimit({ skip })`
 *  option inside a route file that imports every controller is a predicate
 *  nothing can test.
 *
 *  **Publishing is limited; un-publishing never is.** Making a project public
 *  puts it in a gallery every signed-in user can read, so it is the one action
 *  on that route whose cost lands on people other than the person taking it.
 *  Making it private again is the remedy for having published it, and a
 *  limiter that blocked *that* would turn a moment of regret into an hour of
 *  one -- while a burst of un-publishing costs the gallery nothing. So the
 *  budget counts one direction only.
 */
export function countsAgainstPublishBudget(body: unknown): boolean {
  // Read loosely on purpose. This decides only whether to COUNT a request;
  // the controller validates the body properly with zod. A shape this cannot
  // read is one that is about to be rejected there anyway, and charging a
  // budget for a request that was never going to publish anything would let a
  // stream of malformed bodies exhaust an honest user's allowance.
  if (typeof body !== "object" || body === null) return false;

  return (body as { visibility?: unknown }).visibility === "public";
}

/** The limiter itself, built here rather than in the route file.
 *
 *  A factory, not a singleton, for two reasons. A limiter holds counters for
 *  its whole window, so a test that mounted one shared instance would fail on
 *  a budget spent by the test before it rather than on the behaviour it means
 *  to check. And building it here is what lets a test mount **the real
 *  middleware** -- importing the route file instead would drag in every
 *  controller, Prisma and the Docker client to assert on a predicate.
 *
 *  That matters more than it sounds: the predicate above is only half the
 *  design. `skip` inverts it, and an inverted `skip` is a limiter that rations
 *  taking projects down and lets publishing run free -- precisely backwards,
 *  and invisible to any test of the predicate alone.
 */
export function createPublishLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => !countsAgainstPublishBudget(req.body),
    message: {
      success: false,
      code: "RATE_LIMITED",
      message:
        "Too many projects published. Try again later. Making a project " +
        "private is never limited.",
    },
  });
}
