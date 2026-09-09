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
import {
  getAccountSecretsController,
  setAccountSecretsController,
} from "../../controllers/accountSecretController.js";
import {
  getEditorSessionController,
  setEditorSessionController,
} from "../../controllers/editorSessionController.js";

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

// Account-wide environment variables -- plan.md §13.8. On this router for the
// same reason dotfiles are, and session-only for a sharper one: a key that
// could read these would be one credential handing over every other credential
// the account has.
router.get("/secrets", asyncHandler(getAccountSecretsController));
router.put("/secrets", asyncHandler(setAccountSecretsController));

// Where the editor was left -- plan.md §13.11. On this router because the
// session belongs to the PERSON: it is the same account opening the same
// workspace from a second machine, which is the reason the workspace is on a
// server at all. Not under a project, because settings and keybindings are not
// one project's, and the per-project half is a map inside one of the values.
router.get("/session", asyncHandler(getEditorSessionController));
router.put("/session", asyncHandler(setEditorSessionController));

export default router;
