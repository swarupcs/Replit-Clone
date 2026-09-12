import express, { type RequestHandler } from "express";

/** Keeping a webhook's body as the bytes that were sent.
 *
 *  A webhook signature covers the exact bytes the sender hashed. `JSON.parse`
 *  followed by `JSON.stringify` produces a different string — key order, spacing,
 *  number formatting — so a route that verifies a signature must read the raw
 *  body, and any parser that runs first has already destroyed it.
 *
 *  **This existed as a comment on the route and not as behaviour.** `billing.ts`
 *  mounts `express.raw` as route middleware and explains why; `index.ts` mounts
 *  `express.json()` globally in front of the whole API. `express.json` sets
 *  `req._body`, which makes the later `express.raw` skip its work and leave
 *  `req.body` a parsed object — so `Buffer.isBuffer(req.body)` was false, the
 *  raw string was `""`, and every real delivery failed its signature check. The
 *  route's own test could not see it, because the test app is assembled without
 *  the global parser.
 *
 *  So the raw parser has to run BEFORE the JSON one, which means mounting it on
 *  the path rather than on the route. Whichever runs first wins and marks the
 *  request handled; the loser is a no-op. That makes the route's own
 *  `express.raw` harmless to leave in place, and it keeps working when this
 *  file is what is mounted.
 */

/** The full paths whose bodies must not be parsed.
 *
 *  Full paths and not a prefix: this is a list of endpoints that verify a
 *  signature, and a prefix would silently opt in every future route under it —
 *  including ones that want an ordinary parsed body and would get a Buffer.
 *
 *  A webhook added without joining this list is a webhook whose signature check
 *  cannot pass. That is the whole reason the list is here rather than spelled
 *  out at the mount point.
 */
export const WEBHOOK_RAW_PATHS = [
  "/api/v1/billing/webhook",
  "/api/v1/github/webhook",
] as const;

/** The same 1 MB ceiling the routes themselves use. A webhook body is a small
 *  JSON document; anything near this is not one. */
const LIMIT = "1mb";

/** Mount this before `express.json()`. */
export function webhookRawBody(): RequestHandler {
  const raw = express.raw({ type: "application/json", limit: LIMIT });

  return (req, res, next) => {
    // `req.path` is relative to where this is mounted, and it is mounted at the
    // root — but `originalUrl` carries the query string, so the comparison is
    // against the path alone. A webhook is a POST; anything else on these paths
    // has no body worth preserving.
    const path = req.originalUrl.split("?")[0];
    const match = (WEBHOOK_RAW_PATHS as readonly string[]).includes(path ?? "");
    if (!match) {
      next();
      return;
    }
    raw(req, res, next);
  };
}
