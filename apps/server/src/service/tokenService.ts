import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "../utils/errors.js";

export interface AccessTokenClaims {
  sub: string;
  email: string;
}

interface RefreshTokenClaims {
  sub: string;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as SignOptions);
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof payload === "string" || !payload.sub) {
      throw new UnauthorizedError("Malformed access token");
    }
    return { sub: payload.sub, email: String(payload["email"] ?? "") };
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET);
    if (typeof payload === "string" || !payload.sub) {
      throw new UnauthorizedError("Malformed refresh token");
    }
    return { sub: payload.sub };
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }
}

export const REFRESH_COOKIE_NAME = "refresh_token";

/** Cookie carrying preview authorisation.
 *
 *  The preview iframe and Vite's HMR client cannot set an Authorization
 *  header, so /preview authenticates by cookie instead of bearer token. */
export const PREVIEW_COOKIE_NAME = "preview_token";

export function signPreviewToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
  } as SignOptions);
}

export function verifyPreviewToken(token: string): { sub: string } {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof payload === "string" || !payload.sub) {
      throw new UnauthorizedError("Malformed preview token");
    }
    return { sub: payload.sub };
  } catch {
    throw new UnauthorizedError("Invalid or expired preview token");
  }
}

export const refreshCookieMaxAgeMs =
  env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
