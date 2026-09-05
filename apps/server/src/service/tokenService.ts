import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../utils/errors.js";

/** What a token is allowed to do.
 *
 *  Carried as a `typ` claim and checked on every verify. Without it the three
 *  kinds of token were interchangeable wherever they shared a secret: the
 *  preview cookie is signed with the access secret and carries a `sub`, so
 *  `verifyAccessToken` accepted it and `requireAuth` let it through as a bearer
 *  credential — turning a cookie handed to untrusted project code into full API
 *  access for as long as it lived.
 */
type TokenType = "access" | "refresh" | "preview" | "mfa";

interface BaseClaims {
  sub: string;
  typ: TokenType;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
}

interface RefreshTokenClaims {
  sub: string;
}

/** Verifies a signature AND that the token is the kind the caller expects. */
function verifyTyped(
  token: string,
  secret: string,
  expected: TokenType,
  label: string,
): jwt.JwtPayload {
  let payload: string | jwt.JwtPayload;

  try {
    payload = jwt.verify(token, secret);
  } catch {
    throw new UnauthorizedError(`Invalid or expired ${label} token`);
  }

  if (typeof payload === "string" || !payload.sub || payload["typ"] !== expected) {
    throw new UnauthorizedError(`Malformed ${label} token`);
  }

  return payload;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  const payload: BaseClaims & { email: string } = {
    sub: claims.sub,
    email: claims.email,
    typ: "access",
  };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as SignOptions);
}

/** Every refresh token carries a random id.
 *
 *  Without one the payload is just a subject, a type and second-granularity
 *  timestamps, so two tokens minted for the same user within the same second
 *  are byte-identical — and the store, which keys on the token's hash, rejects
 *  the second as a duplicate. Signing in twice quickly, or rotating twice, is
 *  enough to hit that.
 */
export function signRefreshToken(userId: string): string {
  const payload: BaseClaims & { jti: string } = {
    sub: userId,
    typ: "refresh",
    jti: randomUUID(),
  };

  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: `${String(env.REFRESH_TOKEN_TTL_DAYS)}d`,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = verifyTyped(token, env.JWT_ACCESS_SECRET, "access", "access");
  return { sub: payload.sub as string, email: String(payload["email"] ?? "") };
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  const payload = verifyTyped(
    token,
    env.JWT_REFRESH_SECRET,
    "refresh",
    "refresh",
  );
  return { sub: payload.sub as string };
}

/** Proof that the PASSWORD step passed, and nothing else. plan.md §11.6.
 *
 *  A separate type rather than a short-lived access token, which is exactly
 *  the mistake the `typ` claim above exists to prevent: a half-finished
 *  sign-in must not be a credential. `requireAuth` checks for "access", so one
 *  of these presented as a bearer token is refused by the same check that
 *  refuses a preview cookie.
 *
 *  Five minutes, because it is the gap between typing a password and reading a
 *  code off a phone. Long enough to find the phone, short enough that a
 *  challenge left in a closed tab is not a standing half-credential.
 */
const MFA_TOKEN_TTL = "5m";

export function signMfaToken(userId: string): string {
  const payload: BaseClaims = { sub: userId, typ: "mfa" };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: MFA_TOKEN_TTL,
  } as SignOptions);
}

export function verifyMfaToken(token: string): { sub: string } {
  const payload = verifyTyped(token, env.JWT_ACCESS_SECRET, "mfa", "sign-in");
  return { sub: payload.sub as string };
}

export const REFRESH_COOKIE_NAME = "refresh_token";

/** Cookie carrying preview authorisation.
 *
 *  The preview iframe and Vite's HMR client cannot set an Authorization
 *  header, so /preview authenticates by cookie instead of bearer token. */
export const PREVIEW_COOKIE_NAME = "preview_token";

/** Deliberately short-lived, and reissued by every session refresh.
 *
 *  It used to last as long as the refresh token — a month — which is far too
 *  long for a credential that is sent to a container running code the platform
 *  treats as untrusted. */
export function signPreviewToken(userId: string): string {
  const payload: BaseClaims = { sub: userId, typ: "preview" };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${String(env.PREVIEW_TOKEN_TTL_HOURS)}h`,
  } as SignOptions);
}

export function verifyPreviewToken(token: string): { sub: string } {
  const payload = verifyTyped(
    token,
    env.JWT_ACCESS_SECRET,
    "preview",
    "preview",
  );
  return { sub: payload.sub as string };
}

export const refreshCookieMaxAgeMs =
  env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export const previewCookieMaxAgeMs = env.PREVIEW_TOKEN_TTL_HOURS * 60 * 60 * 1000;
