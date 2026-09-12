import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { redeemPairingController } from "../../controllers/pairingController.js";

/** Redeeming a pairing link. plan.md §13.6.
 *
 *  Its own router, mounted without `requireAuth`, because the whole row is
 *  about the person who has no account: requiring one here would be requiring
 *  exactly the thing this exists to avoid.
 */

/** The link is a bearer string, so this endpoint is guessable-at. Limited hard:
 *  32 bytes of randomness is not brute-forceable, but a limiter is what stops
 *  somebody spending this server's CPU finding that out. */
const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: "",
});

const router = express.Router();

router.post("/redeem", redeemLimiter, asyncHandler(redeemPairingController));

export default router;
