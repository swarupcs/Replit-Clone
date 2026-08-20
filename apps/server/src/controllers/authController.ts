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
} from "../service/tokenService.js";
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../service/refreshTokenService.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { UnauthorizedError } from "../utils/errors.js";
import { z } from "zod";
import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { getMailer, hasRealMailer, webUrl } from "../lib/mailer.js";
import {
  consumeUserToken,
  issueUserToken,
  UserTokenPurpose,
} from "../service/userTokenService.js";
import { revokeAllForUser } from "../service/refreshTokenService.js";
import { logger } from "../lib/logger.js";

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

/** Writes the session cookies and returns the access token.
 *
 *  `refreshToken` is supplied by the caller rather than minted here, because a
 *  sign-in starts a new token family while a refresh continues an existing one.
 */
function issueSession(
  res: Response,
  user: { id: string; email: string },
  refreshToken: string,
  message: string,
): void {
  const accessToken = signAccessToken({ sub: user.id, email: user.email });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
  res.cookie(PREVIEW_COOKIE_NAME, signPreviewToken(user.id), previewCookieOptions);

  res.json({ success: true, message, data: { user, accessToken } });
}

export async function signup(req: Request, res: Response): Promise<void> {
  const { email, password } = credentialsSchema.parse(req.body);
  const user = await registerUser(email, password);
  const { token } = await issueRefreshToken(user.id);

  issueSession(res, user, token, "Account created");
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = credentialsSchema.parse(req.body);
  const user = await authenticateUser(email, password);
  const { token } = await issueRefreshToken(user.id);

  issueSession(res, user, token, "Signed in");
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const presented = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!presented) throw new UnauthorizedError("No refresh token");

  // Rotates: the presented token is spent, and presenting it again revokes the
  // whole family. See refreshTokenService.
  const { userId, token } = await rotateRefreshToken(presented);

  const user = await getUserById(userId);
  if (!user) throw new UnauthorizedError("Account no longer exists");

  issueSession(res, user, token, "Session refreshed");
}

export async function logout(req: Request, res: Response): Promise<void> {
  const presented = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;

  // The point of the record: clearing the cookie alone left the token itself
  // working for anyone who had captured it.
  if (presented) await revokeRefreshToken(presented);

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

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

/** Always reports success.
 *
 *  Saying "no account with that email" would turn this endpoint into a way to
 *  discover who has an account here, which is exactly what an attacker wants
 *  before trying passwords.
 */
export async function requestPasswordReset(
  req: Request,
  res: Response,
): Promise<void> {
  const { email } = emailSchema.parse(req.body ?? {});
  const user = await prisma.user.findUnique({ where: { email } });

  if (user?.passwordHash) {
    const token = await issueUserToken(user.id, UserTokenPurpose.PASSWORD_RESET);

    await getMailer().send({
      to: user.email,
      subject: "Reset your password",
      text:
        `Open this link to choose a new password:\n\n` +
        `${webUrl("/reset-password", { token })}\n\n` +
        `It expires in an hour. If you did not ask for this, ignore it — ` +
        `nothing has changed.`,
    });
  } else if (user) {
    // An account created through an identity provider has no password to
    // reset, and telling them to sign in the way they signed up is more useful
    // than a link that cannot help.
    await getMailer().send({
      to: user.email,
      subject: "Reset your password",
      text:
        `This account signs in with GitHub, so it has no password to reset.\n\n` +
        `Use "Continue with GitHub" at ${env.WEB_ORIGIN}.`,
    });
  }

  res.json({
    success: true,
    message: "If that address has an account, a reset link is on its way.",
    // Development has no mailer, so the link goes to the server log; saying so
    // saves a confused wait for an email that is never coming.
    data: { delivered: hasRealMailer() },
  });
}

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, password } = resetSchema.parse(req.body ?? {});

  const userId = await consumeUserToken(token, UserTokenPurpose.PASSWORD_RESET);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
  });

  // Every existing session ends: whoever prompted the reset may be holding one.
  await revokeAllForUser(userId);
  logger.info("password reset", { userId });

  res.json({
    success: true,
    message: "Password changed. Sign in with your new password.",
    data: null,
  });
}

/** Sends a fresh verification link to the signed-in user. */
export async function requestEmailVerification(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const user = await getUserById(userId);
  if (!user) throw new UnauthorizedError("Account no longer exists");

  const token = await issueUserToken(userId, UserTokenPurpose.EMAIL_VERIFICATION);

  await getMailer().send({
    to: user.email,
    subject: "Confirm your email address",
    text:
      `Open this link to confirm this address:\n\n` +
      `${webUrl("/verify-email", { token })}\n\n` +
      `It expires in a day.`,
  });

  res.json({
    success: true,
    message: "Verification link sent.",
    data: { delivered: hasRealMailer() },
  });
}

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const token = z.string().min(1).parse((req.body as { token?: unknown })?.token);

  const userId = await consumeUserToken(token, UserTokenPurpose.EMAIL_VERIFICATION);

  await prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  });

  res.json({ success: true, message: "Email confirmed", data: null });
}
