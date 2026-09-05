import type { CookieOptions } from "express";
import { env, isProduction } from "../config/env.js";
import {
  previewCookieMaxAgeMs,
  refreshCookieMaxAgeMs,
} from "../service/tokenService.js";

/** The two cookies a session is carried by, and the only place their options
 *  are written down.
 *
 *  They lived in `authController` and were copied by hand into
 *  `oauthController`, which is a drift hazard that had already come true in
 *  spirit: the moment the preview cookie needed a `Domain` (plan.md §11.5) the
 *  password path would have grown one and the GitHub sign-in path would not,
 *  so previews would work for accounts that typed a password and be refused
 *  for accounts that clicked "Continue with GitHub" — with nothing in either
 *  code path looking wrong.
 */

/** Spent only at `/api/v1/auth`, on this server's own host.
 *
 *  Deliberately host-only even when COOKIE_DOMAIN is set: widening a session
 *  credential to every sibling name buys nothing, because nothing but the API
 *  ever presents it.
 */
export const refreshCookieOptions: CookieOptions = {
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
 *  shorter than the refresh token's — see signPreviewToken.
 *
 *  The one cookie that has to cross a HOSTNAME. Previews are served from an
 *  origin of their own; locally that differs from the API's by port, and
 *  cookies ignore ports, so nothing is needed. Behind a reverse proxy it is a
 *  different name, a host-only cookie never arrives, and every preview is
 *  refused with nothing in any log to say why. COOKIE_DOMAIN is what closes
 *  that, and `config/exposure.ts` refuses the boot when it is missing or set
 *  to something a browser would reject.
 */
export const previewCookieOptions: CookieOptions = {
  ...refreshCookieOptions,
  path: "/preview",
  maxAge: previewCookieMaxAgeMs,
  domain: env.COOKIE_DOMAIN || undefined,
};
