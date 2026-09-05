import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../lib/logger.js";

/** Says so, once, when a proxy is in front and this server has not been told.
 *
 *  plan.md §11.5. `config/exposure.ts` guesses at boot — HTTPS origins with
 *  zero trusted hops is the shape of somebody who put a proxy in front and did
 *  not come back to the setting — but it can only guess, because a plain-HTTP
 *  proxy on a LAN looks identical to no proxy at all.
 *
 *  A forwarded header arriving is not a guess. It means something in front is
 *  rewriting the request, and with TRUSTED_PROXY_HOPS=0 Express reports every
 *  client as that proxy's address: rate limits then count the whole world as
 *  one caller, so one account's failed sign-ins lock everybody out, and every
 *  logged address is the same useless one.
 *
 *  Once, not per request. This fires on traffic, and a line per request would
 *  bury the log it is trying to be noticed in.
 */
export function proxyHeaderWarning(trustedHops: number): RequestHandler {
  // A configured deployment needs no check at all, so it gets no per-request
  // work either.
  if (trustedHops > 0) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }

  let warned = false;

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!warned) {
      const forwarded =
        req.headers["x-forwarded-for"] ?? req.headers["forwarded"];

      if (forwarded !== undefined) {
        warned = true;
        logger.warn(
          "a proxy is forwarding to this server but TRUSTED_PROXY_HOPS is 0",
          {
            // Named rather than logged whole: the header carries client
            // addresses, and this line exists to report a misconfiguration
            // rather than to record who was behind it.
            header:
              req.headers["x-forwarded-for"] !== undefined
                ? "x-forwarded-for"
                : "forwarded",
            consequence:
              "every request is attributed to the proxy's own address, so " +
              "rate limits apply to all clients together",
          },
        );
      }
    }

    next();
  };
}
