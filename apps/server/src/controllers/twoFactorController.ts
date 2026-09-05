import type { Request, Response } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { UnauthorizedError } from "../utils/errors.js";
import {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from "../service/twoFactorService.js";

/** Turning a second factor on and off. plan.md §11.6.
 *
 *  Everything here is behind `requireAuth`, so the caller already has a
 *  session. The password is asked for again on the two operations that REMOVE
 *  protection -- see `assertPassword` -- because a session is not consent to
 *  weaken the account it belongs to.
 */

const codeSchema = z.object({ code: z.string().trim().min(1).max(64) });
const passwordSchema = z.object({ password: z.string().min(1).max(200) });

/** Re-checks the password before an account is made weaker.
 *
 *  The threat this answers is a session somebody else is holding: a laptop
 *  left open, a stolen access token, a project shared with someone who found
 *  a way to read it. Without this, any of those could switch the second factor
 *  off and keep the account -- which would make it decoration rather than
 *  protection.
 *
 *  An account with no password at all is one created through GitHub sign-in.
 *  It is refused rather than waved through: "there is nothing to check" is not
 *  the same as "the check passed".
 */
async function assertPassword(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });

  if (!user?.passwordHash) {
    throw new UnauthorizedError(
      "This account has no password to confirm with. Set one first.",
      "NO_PASSWORD",
    );
  }

  let valid = false;
  try {
    valid = await argon2.verify(user.passwordHash, password);
  } catch {
    valid = false;
  }

  if (!valid) throw new UnauthorizedError("That password is not right.");
}

export async function twoFactorStatusController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  res.json({ data: await getTwoFactorStatus(userId) });
}

/** Starts enrolment and hands back the secret ONCE, in the two forms an
 *  authenticator app can take it: a URL to scan and the text to type. */
export async function beginTwoFactorController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId, email } = getAuthContext(req);
  res.json({ data: await beginEnrolment(userId, email) });
}

/** Finishes enrolment. Returns the recovery codes, which are readable here and
 *  nowhere else, ever again. */
export async function confirmTwoFactorController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { code } = codeSchema.parse(req.body);

  res.json({
    data: {
      recoveryCodes: await confirmEnrolment(userId, code),
      status: await getTwoFactorStatus(userId),
    },
  });
}

export async function disableTwoFactorController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { password } = passwordSchema.parse(req.body);

  await assertPassword(userId, password);
  await disableTwoFactor(userId);

  res.json({ data: await getTwoFactorStatus(userId) });
}

/** New codes, and the old ones stop working.
 *
 *  Behind the password as well, and for the same reason as disabling: somebody
 *  holding a session could otherwise mint themselves a set of ten permanent
 *  bypasses and leave the second factor apparently intact, which is worse than
 *  turning it off because nothing would look wrong.
 */
export async function regenerateRecoveryCodesController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const { password } = passwordSchema.parse(req.body);

  await assertPassword(userId, password);

  res.json({
    data: {
      recoveryCodes: await regenerateRecoveryCodes(userId),
      status: await getTwoFactorStatus(userId),
    },
  });
}
