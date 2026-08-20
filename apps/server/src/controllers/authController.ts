import type { CookieOptions, Request, Response } from "express";
import { credentialsSchema } from "@replit-clone/shared";
import { env, isProduction } from "../config/env.js";
import {
  authenticateUser,
  getUserById,
  registerUser,
} from "../service/authService.js";
import {
  PREVIEW_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  previewCookieMaxAgeMs,
  refreshCookieMaxAgeMs,
  signAccessToken,
  signPreviewToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../service/tokenService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { UnauthorizedError } from "../utils/errors.js";

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  // COOKIE_SAME_SITE defaults to "lax" for a same-site deployment (frontend
  // and API on the same domain). A split deployment -- e.g. the web app on
  // Vercel and the API on a separate host -- MUST set this to "none", or the
  // browser drops the cookie on every cross-site request and login appears to
  // just not work.
  sameSite: env.COOKIE_SAME_SITE,
  // Secure defaults to true in production and false otherwise, but is
  // explicitly overridable: "none" REQUIRES Secure, while a plain-HTTP LAN
  // deployment in production mode needs it forced to false, or the browser
  // silently discards the cookie.
  secure: env.COOKIE_SECURE ?? isProduction,
  maxAge: refreshCookieMaxAgeMs,
  path: "/api/v1/auth",
};

/** Scoped to /preview so it is sent with the preview iframe and its HMR
 *  socket, and with nothing else. Its lifetime tracks the token's, which is far
 *  shorter than the refresh token's — see signPreviewToken. */
const previewCookieOptions: CookieOptions = {
  ...refreshCookieOptions,
  path: "/preview",
  maxAge: previewCookieMaxAgeMs,
};

function issueSession(
  res: Response,
  user: { id: string; email: string },
  message: string,
): void {
  const accessToken = signAccessToken({ sub: user.id, email: user.email });

  res.cookie(REFRESH_COOKIE_NAME, signRefreshToken(user.id), refreshCookieOptions);
  res.cookie(PREVIEW_COOKIE_NAME, signPreviewToken(user.id), previewCookieOptions);

  res.json({ success: true, message, data: { user, accessToken } });
}

export async function signup(req: Request, res: Response): Promise<void> {
  const { email, password } = credentialsSchema.parse(req.body);
  const user = await registerUser(email, password);
  issueSession(res, user, "Account created");
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = credentialsSchema.parse(req.body);
  const user = await authenticateUser(email, password);
  issueSession(res, user, "Signed in");
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!token) throw new UnauthorizedError("No refresh token");

  const { sub } = verifyRefreshToken(token);
  const user = await getUserById(sub);
  if (!user) throw new UnauthorizedError("Account no longer exists");

  issueSession(res, user, "Session refreshed");
}

export async function logout(_req: Request, res: Response): Promise<void> {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions, maxAge: undefined });
  res.clearCookie(PREVIEW_COOKIE_NAME, { ...previewCookieOptions, maxAge: undefined });
  res.json({ success: true, message: "Signed out", data: null });
}

export async function me(req: Request, res: Response): Promise<void> {
  const { userId } = getAuthContext(req);

  const user = await getUserById(userId);
  if (!user) throw new UnauthorizedError("Account no longer exists");

  res.json({ success: true, message: "Current user", data: { user } });
}

