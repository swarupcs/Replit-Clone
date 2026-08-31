import type { Request, Response } from "express";
import { z } from "zod";
import { API_KEY_SCOPES, MAX_KEY_LABEL } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../service/apiKeyService.js";

/** Minting and revoking keys.
 *
 *  On the account router, which is session-only, and that is deliberate: a key
 *  cannot reach these endpoints, so a stolen key cannot issue itself a fresh
 *  one with wider scopes. Revocation that a thief can undo is not revocation.
 */
const createSchema = z.object({
  label: z.string().trim().min(1).max(MAX_KEY_LABEL),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  /** Optional, and capped at a year. A key that never expires is one nobody
   *  ever has to think about again, which is the state this is trying to
   *  avoid — but forcing an expiry on a build pipeline nobody is watching
   *  breaks it at 3am, so it is offered rather than required. */
  expiresInDays: z.number().int().positive().max(365).optional(),
});

export async function listApiKeysController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  res.json({ success: true, message: "Keys", data: await listApiKeys(userId) });
}

export async function createApiKeyController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const body = createSchema.parse(req.body ?? {});

  const created = await createApiKey({ userId, ...body });

  // 201 with the secret in it, once. There is no route that returns it again,
  // because it is not stored -- only its hash is.
  res.status(201).json({ success: true, message: "Key created", data: created });
}

export async function revokeApiKeyController(
  req: Request<{ keyId: string }>,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  await revokeApiKey(userId, req.params.keyId);
  res.json({ success: true, message: "Key revoked", data: null });
}
