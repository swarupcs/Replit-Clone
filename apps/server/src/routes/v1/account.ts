import express from "express";
import { asyncHandler } from "../../middlewares/errorHandler.js";
import { accountSummaryController } from "../../controllers/accountController.js";
import {
  createApiKeyController,
  listApiKeysController,
  revokeApiKeyController,
} from "../../controllers/apiKeyController.js";
import {
  getPersonalizationController,
  updatePersonalizationController,
} from "../../controllers/personalizationController.js";

/** Somebody's own account: what they are using, and what they are allowed.
 *
 *  One endpoint rather than three, because the three are only meaningful
 *  together — a number, its limit, and what is responsible for it. Mounted
 *  behind `requireAuth` in the parent router.
 */
const router = express.Router();

router.get("/", asyncHandler(accountSummaryController));

// Session-only, like everything on this router, and for a reason worth
// stating: an API key cannot reach here, so a stolen key cannot mint itself a
// replacement with wider scopes. Revocation a thief can undo is not
// revocation.
router.get("/keys", asyncHandler(listApiKeysController));
router.post("/keys", asyncHandler(createApiKeyController));
router.delete("/keys/:keyId", asyncHandler(revokeApiKeyController));

// Dotfiles -- plan.md §11.9. On this router rather than under a project,
// because it is a property of the PERSON: the same settings follow them into
// every container they open, including ones they do not own.
router.get("/personalization", asyncHandler(getPersonalizationController));
router.patch("/personalization", asyncHandler(updatePersonalizationController));

export default router;
