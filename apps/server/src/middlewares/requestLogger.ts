import type { NextFunction, Request, Response } from "express";
import {
  currentRequestId,
  logger,
  newRequestId,
  withLogContext,
} from "../lib/logger.js";

/** Paths noisy enough that logging every hit buries everything else. */
const QUIET_PREFIXES = ["/preview/", "/health", "/ping"];

function isQuiet(path: string): boolean {
  return QUIET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Gives every request an id and logs how it finished.
 *
 *  The id is echoed as `X-Request-Id`, so a user reporting a failure can quote
 *  something that finds the exact line — which is the whole reason the id
 *  exists. An inbound one is honoured, so a request that crossed a proxy or
 *  another service keeps a single id end to end.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers["x-request-id"];
  const requestId =
    typeof inbound === "string" && inbound.length <= 200 ? inbound : newRequestId();

  res.setHeader("X-Request-Id", requestId);

  withLogContext({ requestId }, () => {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      if (isQuiet(req.path) && res.statusCode < 400) return;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      };

      // A 5xx is ours; a 4xx is the caller's and is not worth a warning at
      // volume, beyond what the handler itself already reported.
      if (res.statusCode >= 500) logger.error("request failed", undefined, fields);
      else logger.info("request", fields);
    });

    next();
  });
}

export { currentRequestId };
