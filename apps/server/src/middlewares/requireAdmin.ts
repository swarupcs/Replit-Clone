import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { ForbiddenError } from "../utils/errors.js";
import { getAuthContext } from "./requireAuth.js";

/** Who may act on reports.
 *
 *  `ADMIN_EMAILS` rather than a role on `User`, because this app is deployed
 *  as one operator running their own instance. The check is deliberately in
 *  one place: replacing the allowlist with real roles later means rewriting
 *  this function and nothing else.
 *
 *  Mounted AFTER `requireAuth`, always. It reads the auth context and would
 *  throw Unauthorized without one — correct, but a confusing way to find out
 *  that a router forgot its auth.
 */

/** The allowlist, parsed.
 *
 *  Case-insensitive and whitespace-tolerant, because this value is typed into
 *  a `.env` file or a compose file by hand and `ADMIN_EMAILS=a@b.c, d@e.f`
 *  should not silently grant access to one of the two.
 */
export function adminEmails(raw: string = env.ADMIN_EMAILS): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export function isAdminEmail(
  email: string,
  raw: string = env.ADMIN_EMAILS,
): boolean {
  const allowed = adminEmails(raw);
  // An empty allowlist means nobody. Stated as its own branch rather than
  // left to `Set.has` on an empty set, because the failure it prevents --
  // an unconfigured deployment handing the report queue to everyone who
  // signed up -- is worth being unable to introduce by accident.
  if (allowed.size === 0) return false;

  return allowed.has(email.trim().toLowerCase());
}

export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const { email } = getAuthContext(req);

    if (!isAdminEmail(email)) {
      // 403 and a message that does not confirm the queue exists in any
      // particular shape. Somebody probing for an admin surface learns that
      // they are not on a list, which they could have guessed.
      next(new ForbiddenError("This account cannot review reports.", "NOT_ADMIN"));
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}
