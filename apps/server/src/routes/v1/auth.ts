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
  githubCallback,
  githubStart,
  githubStatus,
} from "../../controllers/oauthController.js";

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
 */
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  legacyHeaders: false,
  message: RATE_LIMITED,
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email : "";
    return `account:${email.trim().toLowerCase()}`;
  },
  // A request with no email is not an attempt against any account; leave it to
  // the address limiter.
  skip: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    return typeof body?.email !== "string";
  },
});

/** Refresh is unauthenticated and hits the database, so it gets a budget too —
 *  a generous one, since an active editor refreshes on its own schedule. */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: RATE_LIMITED,
});

router.post("/signup", addressLimiter, asyncHandler(signup));
router.post("/login", addressLimiter, accountLimiter, asyncHandler(login));
router.post("/refresh", refreshLimiter, asyncHandler(refresh));
router.post("/logout", asyncHandler(logout));
router.get("/me", requireAuth, asyncHandler(me));

// Reset requests are rate-limited on the same budget as sign-in: the endpoint
// sends mail on someone else's behalf, which is worth abusing.
router.post("/password-reset", addressLimiter, accountLimiter, asyncHandler(requestPasswordReset));
router.post("/password-reset/confirm", addressLimiter, asyncHandler(resetPassword));

router.post(
  "/verify-email/request",
  requireAuth,
  addressLimiter,
  asyncHandler(requestEmailVerification),
);
router.post("/verify-email", addressLimiter, asyncHandler(verifyEmail));

// --- GitHub sign-in ------------------------------------------------------
// Off unless a client id and secret are configured; `providers` is what the
// web app asks so it knows whether to offer the button at all.
router.get("/providers", asyncHandler(githubStatus));
router.get("/github", addressLimiter, asyncHandler(githubStart));
router.get("/github/callback", asyncHandler(githubCallback));

export default router;
