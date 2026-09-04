import express from "express";
import rateLimit from "express-rate-limit";
import {
  login,
  logout,
  me,
  refresh,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from "../../controllers/authController.js";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { requireAuth } from "../../middlewares/requireAuth.js";
import {
  authProviders,
  githubCallback,
  githubStart,
} from "../../controllers/oauthController.js";
import { singleUserEnabled } from "../../service/singleUserService.js";

const router = express.Router();

const RATE_LIMITED = {
  success: false,
  code: "RATE_LIMITED",
  message: "Too many attempts. Try again later.",
};

/** Credential endpoints are the obvious brute-force target, so they get a
 *  tighter budget than the rest of the API.
 *
 *  Keyed on the client address, which only means anything once
 *  TRUSTED_PROXY_HOPS is set for the deployment — see config/env.ts. */
const addressLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: RATE_LIMITED,
});

/** Second budget, keyed on the account being targeted.
 *
 *  An address limit alone does not protect an individual account: an attacker
 *  spread across many addresses gets 20 guesses from each of them. This caps
 *  what any one account can be subjected to no matter where it comes from.
 *
 *  Two details keep it from becoming a way to lock somebody OUT of their own
 *  account, which is what it was before:
 *
 *  - Only FAILED attempts count. `skipSuccessfulRequests` means the real owner
 *    signing in correctly never spends budget, so an attacker cannot fill it
 *    and leave them stranded on the right password.
 *  - Sign-in and password reset get separate budgets. They shared one
 *    instance, so burning the sign-in allowance also blocked the one route
 *    that could have recovered the account.
 */
function accountLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: false,
    legacyHeaders: false,
    message: RATE_LIMITED,
    // The owner getting it right costs nothing, so an attacker's failures
    // cannot deny them their own account.
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const body = req.body as { email?: unknown } | undefined;
      const email = typeof body?.email === "string" ? body.email : "";
      return `account:${email.trim().toLowerCase()}`;
    },
    // A request with no email is not an attempt against any account; leave it
    // to the address limiter.
    skip: (req) => {
      const body = req.body as { email?: unknown } | undefined;
      return typeof body?.email !== "string";
    },
  });
}

/** Separate instances, so exhausting one does not close the other. */
const loginAccountLimiter = accountLimiter();
const resetAccountLimiter = accountLimiter();

/** Refresh is unauthenticated and hits the database, so it gets a budget too —
 *  a generous one, since an active editor refreshes on its own schedule. */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: RATE_LIMITED,
});

// Always mounted. Every route in this product authenticates through a session,
// so these four exist in every mode -- a server that issued a session to
// anybody who asked would be an unauthenticated server on whatever network it
// can be reached from, which is not what "personal" means.
router.post("/login", addressLimiter, loginAccountLimiter, asyncHandler(login));
router.post("/refresh", refreshLimiter, asyncHandler(refresh));
router.post("/logout", asyncHandler(logout));
router.get("/me", requireAuth, asyncHandler(me));

// What this server offers, which the web app asks before drawing the sign-in
// form. Always mounted, because its answer is what tells the app which of the
// routes below exist.
router.get("/providers", asyncHandler(authProviders));

// --- Everything that CREATES or RECOVERS an account ------------------------
//
// Not mounted at all in single-user mode, rather than mounted and refusing.
// The difference is the whole point: a guard inside each controller is a rule
// the next route somebody adds does not know to ask about, and §6 decision 17
// prefers a default-deny that is structural over one that is enforced. Here
// that is literally true -- the handler is not reachable, so it cannot be
// reached by forgetting something.
//
// What replaces the recovery half: SINGLE_USER_PASSWORD and a restart. See
// `singleUserService`, which rewrites the password at every boot precisely so
// that the environment is the way back in rather than an inbox.
if (!singleUserEnabled()) {
  router.post("/signup", addressLimiter, asyncHandler(signup));

  // Reset requests are rate-limited on the same budget as sign-in: the
  // endpoint sends mail on someone else's behalf, which is worth abusing.
  router.post(
    "/password-reset",
    addressLimiter,
    resetAccountLimiter,
    asyncHandler(requestPasswordReset),
  );
  router.post("/password-reset/confirm", addressLimiter, asyncHandler(resetPassword));

  router.post(
    "/verify-email/request",
    requireAuth,
    addressLimiter,
    asyncHandler(requestEmailVerification),
  );
  router.post("/verify-email", addressLimiter, asyncHandler(verifyEmail));

  // --- GitHub sign-in ----------------------------------------------------
  // Off unless a client id and secret are configured. Off in single-user mode
  // whatever they are, because signing in with GitHub is a way to CREATE an
  // account and this deployment has the one it is going to have.
  //
  // Connecting GitHub to reach repositories is a different consent on a
  // different router (`routes/v1/github.ts`) and is unaffected -- decision 7
  // already keeps those two apart, and importing a repository is exactly the
  // kind of thing a personal deployment wants.
  router.get("/github", addressLimiter, asyncHandler(githubStart));
  router.get("/github/callback", asyncHandler(githubCallback));
}

export default router;
