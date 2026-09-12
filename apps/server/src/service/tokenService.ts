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
type TokenType = "access" | "refresh" | "preview" | "mfa" | "pairing";

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

/** A guest paired into ONE project, with no account. plan.md §13.6.
 *
 *  **The `pid` claim is what makes this safe, and it is why this is not an
 *  access token with a short life.** An access token says who you are and is
 *  good everywhere; this says who you are *here*, and is good for one project.
 *  Without the project in the token, a pairing credential would be a general
 *  API credential belonging to nobody — which is the exact failure the `typ`
 *  claim was added to stop, one level up.
 *
 *  `sub` is a generated guest id and never a `userId`: there is no account, and
 *  a guest id that collided with a real one would be an account takeover
 *  spelled as a join link.
 */
export interface PairingClaims {
  /** The guest's id for this session. Not a user, and not stored as one. */
  sub: string;
  /** The one project this credential is good for. */
  pid: string;
  /** What they may do in it. Never more than the invite granted. */
  role: "VIEWER" | "EDITOR";
  /** What to call them in presence. Theirs to choose, so it is bounded and
   *  never trusted as an identity. */
  nam: string;
}

export function signPairingToken(claims: PairingClaims): string {
  const payload: BaseClaims & Omit<PairingClaims, "sub"> = {
    sub: claims.sub,
    typ: "pairing",
    pid: claims.pid,
    role: claims.role,
    nam: claims.nam,
  };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${String(env.PAIRING_TOKEN_TTL_HOURS)}h`,
  } as SignOptions);
}

export function verifyPairingToken(token: string): PairingClaims {
  const payload = verifyTyped(token, env.JWT_ACCESS_SECRET, "pairing", "pairing");

  const pid = payload["pid"];
  const role = payload["role"];
  const nam = payload["nam"];

  // A pairing token with no project is a pairing token for every project, so
  // it is refused rather than defaulted.
  if (typeof pid !== "string" || pid.length === 0) {
    throw new UnauthorizedError("Malformed pairing token");
  }
  if (role !== "VIEWER" && role !== "EDITOR") {
    throw new UnauthorizedError("Malformed pairing token");
  }

  return {
    sub: payload.sub as string,
    pid,
    role,
    // An EMPTY name is as absent as a missing one: `typeof nam === "string"`
    // alone admits "", which reaches the UI as a cursor with no label beside
    // it. Checked for length, not just for type.
    nam: typeof nam === "string" && nam.length > 0 ? nam : "Guest",
  };
}

export const refreshCookieMaxAgeMs =
  env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export const previewCookieMaxAgeMs = env.PREVIEW_TOKEN_TTL_HOURS * 60 * 60 * 1000;
