import { randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { env, isProduction } from "../config/env.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { logger } from "../lib/logger.js";
import { signAccessToken, verifyAccessToken } from "../service/tokenService.js";
import {
  connectAuthorizeUrl,
  connectGithub,
  disconnectGithub,
  githubConnection,
  isGithubReposConfigured,
  listRepos,
} from "../service/githubService.js";
import { z } from "zod";
import { BadRequestError, UnauthorizedError } from "../utils/errors.js";

/** The connect round trip is a browser redirect, not an API call, so the
 *  request that comes back from GitHub carries no Authorization header. Two
 *  things therefore travel in cookies: the OAuth `state`, which is what makes
 *  the callback verifiable at all, and who started it.
 *
 *  Scoped to this path and short-lived, because the trip takes seconds. */
const STATE_COOKIE = "gh_connect_state";
const ACTOR_COOKIE = "gh_connect_actor";

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.COOKIE_SECURE ?? isProduction,
  maxAge: 10 * 60 * 1000,
  path: "/api/v1/github",
};

export async function githubConnectionStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);

  // Configured and connected are different questions, and the app needs both:
  // one decides whether to offer the button, the other what the button says.
  const connection = isGithubReposConfigured()
    ? await githubConnection(userId)
    : null;

  res.json({
    success: true,
    message: "GitHub connection",
    data: { configured: isGithubReposConfigured(), connection },
  });
}

/** Starts the consent flow.
 *
 *  Answers with the URL rather than redirecting, because this is called by the
 *  app with its access token; the browser then follows it. A redirect here
 *  would have to be made from a plain link, which cannot carry the header.
 */
export function githubConnectStart(req: Request, res: Response): Promise<void> {
  const { userId, email } = getAuthContext(req);

  if (!isGithubReposConfigured()) {
    throw new BadRequestError(
      "GitHub repositories are not configured on this server",
      "GITHUB_NOT_CONFIGURED",
    );
  }

  const state = randomBytes(24).toString("base64url");

  res.cookie(STATE_COOKIE, state, cookieOptions);
  // A signed token rather than the raw id: this cookie decides whose account
  // the returning authorisation is attached to, so it has to be one this
  // server issued and not one a browser was handed.
  res.cookie(ACTOR_COOKIE, signAccessToken({ sub: userId, email }), cookieOptions);

  res.json({
    success: true,
    message: "Authorize with GitHub",
    data: { url: connectAuthorizeUrl(state) },
  });

  return Promise.resolve();
}

/** Where GitHub sends the browser back. Ends in a redirect to the app. */
export async function githubConnectCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const code = req.query["code"];
  const state = req.query["state"];
  const cookies = req.cookies as Record<string, string> | undefined;

  // Good for exactly one attempt, whatever the outcome.
  const clear = { ...cookieOptions, maxAge: undefined };
  res.clearCookie(STATE_COOKIE, clear);
  res.clearCookie(ACTOR_COOKIE, clear);

  const finish = (query: string) => {
    res.redirect(`${env.WEB_ORIGIN}/?github=${query}`);
  };

  const fail = (reason: string) => {
    logger.warn("github connect failed", { reason });
    finish("error");
  };

  if (typeof code !== "string" || code.length === 0) {
    fail("no code");
    return;
  }

  if (
    typeof state !== "string" ||
    !cookies?.[STATE_COOKIE] ||
    state !== cookies[STATE_COOKIE]
  ) {
    // A mismatch means this callback was not started by this browser, which is
    // exactly the case where attaching a token to an account would be wrong.
    fail("state mismatch");
    return;
  }

  const actor = cookies[ACTOR_COOKIE];
  if (!actor) {
    fail("no actor");
    return;
  }

  let userId: string;
  try {
    userId = verifyAccessToken(actor).sub;
  } catch {
    fail("actor expired");
    return;
  }

  try {
    const connection = await connectGithub(userId, code);
    logger.info("github connected", { userId, login: connection.login });

    // The app reads this to say what happened; nothing sensitive is in it.
    finish(connection.canUseRepos ? "connected" : "limited");
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError) {
      fail(error.message);
      return;
    }
    throw error;
  }
}

export async function githubDisconnect(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);

  await disconnectGithub(userId);
  logger.info("github disconnected", { userId });

  res.json({ success: true, message: "GitHub disconnected", data: null });
}


/** Page and query, validated rather than trusted.
 *
 *  The page is capped: it is forwarded to GitHub, and an unbounded number is a
 *  way to make this server issue arbitrarily many requests on someone's behalf.
 */
const listQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
});

export async function githubReposController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { query, page } = listQuerySchema.parse(req.query);

  const result = await listRepos(userId, { ...(query ? { query } : {}), page });

  res.json({
    success: true,
    message: "GitHub repositories",
    data: result,
  });
}
