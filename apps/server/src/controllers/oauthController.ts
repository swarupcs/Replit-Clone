import { randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { env, isProduction } from "../config/env.js";
import {
  githubAuthorizeUrl,
  isGithubConfigured,
  signInWithGithub,
} from "../service/oauthService.js";
import { capabilities } from "../config/deploymentMode.js";
import { singleUserEnabled } from "../service/singleUserService.js";
import { issueRefreshToken } from "../service/refreshTokenService.js";
import {
  PREVIEW_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  signPreviewToken,
} from "../service/tokenService.js";
import {
  previewCookieOptions,
  refreshCookieOptions,
} from "./sessionCookies.js";
import { BadRequestError, UnauthorizedError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";

/** The OAuth `state` parameter, kept in a cookie for the round trip.
 *
 *  This is what makes the callback verifiable: without it, anyone could send a
 *  victim to our callback with a code of their own and have the victim's
 *  browser sign in as somebody else. Short-lived, because the round trip takes
 *  seconds. */
const STATE_COOKIE_NAME = "oauth_state";

const stateCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.COOKIE_SECURE ?? isProduction,
  maxAge: 10 * 60 * 1000,
  path: "/api/v1/auth",
};

/** What this server's sign-in screen may offer.
 *
 *  Renamed from `githubStatus` when it stopped being only about GitHub. The
 *  web app asks it before drawing the form, and in single-user mode there are
 *  three things on that form -- Sign up, Forgot password, Continue with GitHub
 *  -- that lead to routes which are not mounted. A link to a 404 is a worse
 *  answer than no link.
 */
export function authProviders(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    message: "Sign-in providers",
    data: {
      // Never in single-user mode, whatever is configured: GitHub sign-in
      // creates accounts, and this deployment has the one it is going to have.
      github: isGithubConfigured() && !singleUserEnabled(),
      singleUser: singleUserEnabled(),
      // What this deployment has routes for. The app hides a Share button
      // whose endpoint is a 404 for the same reason it hides a signup link
      // whose endpoint is a 404 -- and this is the one place both answers
      // already travel together.
      capabilities: capabilities(),
    },
  });

  return Promise.resolve();
}

/** Sends the browser to GitHub. */
export function githubStart(_req: Request, res: Response): Promise<void> {
  const state = randomBytes(24).toString("base64url");

  res.cookie(STATE_COOKIE_NAME, state, stateCookieOptions);
  res.redirect(githubAuthorizeUrl(state));

  return Promise.resolve();
}

/** Where GitHub sends the browser back.
 *
 *  Ends in a redirect to the web app rather than a JSON body, because it is the
 *  browser following a link rather than the app making a request. The access
 *  token is handed over through the session cookies plus a one-shot redirect;
 *  the app then calls /refresh to pick up an access token, exactly as it does
 *  on any other reload.
 */
export async function githubCallback(req: Request, res: Response): Promise<void> {
  const code = req.query["code"];
  const state = req.query["state"];
  const expected = (req.cookies as Record<string, string> | undefined)?.[
    STATE_COOKIE_NAME
  ];

  // Cleared whatever happens: it is good for exactly one attempt.
  res.clearCookie(STATE_COOKIE_NAME, { ...stateCookieOptions, maxAge: undefined });

  const fail = (reason: string) => {
    logger.warn("github sign-in failed", { reason });
    res.redirect(`${env.WEB_ORIGIN}/login?error=github`);
  };

  if (typeof code !== "string" || code.length === 0) {
    fail("no code");
    return;
  }

  if (typeof state !== "string" || !expected || state !== expected) {
    // A mismatch means this callback was not started by this browser.
    fail("state mismatch");
    return;
  }

  try {
    const user = await signInWithGithub(code);
    const { token } = await issueRefreshToken(user.id);

    // The same options the password path uses, imported rather than repeated.
    // They were copied here, which is how the preview cookie's Domain (§11.5)
    // would have reached one sign-in route and not the other.
    res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions);
    res.cookie(
      PREVIEW_COOKIE_NAME,
      signPreviewToken(user.id),
      previewCookieOptions,
    );

    logger.info("github sign-in", { userId: user.id });
    res.redirect(env.WEB_ORIGIN);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
      fail(error.message);
      return;
    }
    throw error;
  }
}
