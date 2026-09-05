import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import {
  getPersonalization,
  updatePersonalization,
} from "../service/personalizationService.js";

/** `.nullable().optional()` on every field, and the two mean different things.
 *
 *  Absent leaves the column alone; null (or an empty string, which the service
 *  folds to null) clears it. A schema that only allowed one of those would
 *  make "stop cloning my dotfiles" unsayable without a second endpoint.
 *
 *  The lengths are here rather than only in the service so that an implausible
 *  body is refused before anything reads it. The real rules -- https only, no
 *  credentials in the URL, not the app directory -- live in `dotfiles.ts`,
 *  next to the clone they protect.
 */
const updateSchema = z.object({
  dotfilesRepo: z.string().max(500).nullable().optional(),
  dotfilesTarget: z.string().max(500).nullable().optional(),
  dotfilesInstall: z.string().max(500).nullable().optional(),

  // Generous, because an RSA key is several kilobytes and refusing one for
  // being long would be a confusing way to say "use ed25519". The parser is
  // what decides whether it is a key.
  signingKey: z.string().max(20000).nullable().optional(),
  signCommits: z.boolean().optional(),
});

export async function getPersonalizationController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  res.json({ data: await getPersonalization(userId) });
}

export async function updatePersonalizationController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const update = updateSchema.parse(req.body);
  res.json({ data: await updatePersonalization(userId, update) });
}
