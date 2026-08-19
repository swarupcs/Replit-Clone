import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../service/tokenService.js";
import { UnauthorizedError } from "../utils/errors.js";

export interface AuthContext {
  userId: string;
  email: string;
}

/** Per-request auth context.
 *
 *  Kept in a WeakMap rather than bolted onto `req` via module augmentation:
 *  pnpm's nested @types copies make augmenting express unreliable, and this
 *  cannot collide with a property another middleware sets.
 */
const authContexts = new WeakMap<Request, AuthContext>();

export function getAuthContext(req: Request): AuthContext {
  const context = authContexts.get(req);
  if (!context) throw new UnauthorizedError();
  return context;
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    next(new UnauthorizedError("Missing bearer token"));
    return;
  }

  try {
    const claims = verifyAccessToken(header.slice("Bearer ".length));
    authContexts.set(req, { userId: claims.sub, email: claims.email });
    next();
  } catch (error) {
    next(error);
  }
}
