import type { NextFunction, Request, Response } from "express";
import type { ApiKeyScope } from "@replit-clone/shared";
import { verifyApiKey } from "../service/apiKeyService.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import { extendLogContext } from "../lib/logger.js";

/** Authenticating a machine rather than a person.
 *
 *  Separate from `requireAuth` rather than an option on it, and the separation
 *  is the security design rather than tidiness. A key is long-lived and lives
 *  where nobody is looking; if it produced the same auth context a session
 *  does, it would inherit the entire signed-in surface — every project
 *  deleted, every environment variable read, the account's plan changed — and
 *  the only thing standing between a leaked CI secret and all of that would be
 *  a list of exceptions somebody has to keep complete.
 *
 *  So keys reach exactly one router, `routes/v1/pub.ts`, and nothing else in
 *  the product knows they exist. A route that is not written there is not
 *  reachable by a key, which is a guarantee that cannot be forgotten — the
 *  same reasoning §6 decision 13 gives about queries and cleanup.
 */

export interface ApiKeyContext {
  userId: string;
  email: string;
  keyId: string;
  scopes: ApiKeyScope[];
}

const contexts = new WeakMap<Request, ApiKeyContext>();

export function getApiKeyContext(req: Request): ApiKeyContext {
  const context = contexts.get(req);
  if (!context) throw new UnauthorizedError();
  return context;
}

export function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    next(new UnauthorizedError("Missing API key", "BAD_API_KEY"));
    return;
  }

  verifyApiKey(header.slice("Bearer ".length))
    .then((verified) => {
      contexts.set(req, verified);
      // The key, not just the account: after an incident the question is which
      // credential did it, and an account id cannot answer that.
      extendLogContext({ userId: verified.userId, apiKeyId: verified.keyId });
      next();
    })
    .catch((error: unknown) => {
      next(error);
    });
}

/** Refuses a key that was not given this scope.
 *
 *  Placed on each route rather than inferred from the method, because "what
 *  this endpoint costs" and "whether it is a GET" are not the same question —
 *  publishing is a POST that spends a container, and listing projects is a GET
 *  that spends nothing.
 */
export function requireScope(scope: ApiKeyScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const { scopes } = getApiKeyContext(req);

      if (!scopes.includes(scope)) {
        next(
          new ForbiddenError(
            `This key does not have the "${scope}" scope.`,
            "MISSING_SCOPE",
          ),
        );
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
