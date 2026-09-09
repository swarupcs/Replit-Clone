import type { Request, Response } from "express";
import type { AccountSecrets } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { prisma } from "../lib/prisma.js";
import {
  getAccountSecrets,
  setAccountSecrets,
} from "../service/accountSecretService.js";
import { envVarsEncryptedAtRest } from "../service/projectEnvService.js";

/** An account's own environment variables. plan.md §13.8.
 *
 *  Session-only, like everything else on the account router, and here that is
 *  load-bearing rather than conventional: an API key that could read this
 *  would be one credential that hands over every other credential the account
 *  has.
 */

/** How many of this account's projects somebody else can reach.
 *
 *  On the response rather than left for the client to work out, because it is
 *  the one number that turns "these go into every project you own" from a
 *  sentence people skim into one they read. Counted per request: it is two
 *  cheap queries against indexed columns, and a stale answer here is a wrong
 *  answer about who can see a secret.
 */
async function sharedProjectCount(userId: string): Promise<number> {
  return prisma.project.count({
    where: {
      ownerId: userId,
      deletedAt: null,
      OR: [
        { collaborators: { some: {} } },
        // A share link nobody has redeemed yet is still a way in, and somebody
        // deciding whether to store a key here should be told about it.
        { shareToken: { not: null } },
      ],
    },
  });
}

async function respond(userId: string, res: Response): Promise<void> {
  const [vars, sharedProjects] = await Promise.all([
    getAccountSecrets(userId),
    sharedProjectCount(userId),
  ]);

  const body: AccountSecrets = {
    vars,
    encryptedAtRest: envVarsEncryptedAtRest(),
    sharedProjects,
  };

  res.json({ success: true, message: "Account secrets", data: body });
}

export async function getAccountSecretsController(
  req: Request,
  res: Response,
): Promise<void> {
  await respond(getAuthContext(req).userId, res);
}

export async function setAccountSecretsController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);

  // The whole set replaces the whole set. A patch cannot express "delete this
  // one", and deletion is the operation somebody most needs to be certain of
  // when what they are deleting is a live credential.
  const vars: unknown = (req.body as { vars?: unknown } | undefined)?.vars ?? {};
  await setAccountSecrets(userId, vars);

  // Re-read rather than echo, so the client's next render is the truth about
  // what is stored — including `sharedProjects`, which the caller cannot know.
  await respond(userId, res);
}
