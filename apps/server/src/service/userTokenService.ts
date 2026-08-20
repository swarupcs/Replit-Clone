import { createHash, randomBytes } from "node:crypto";
import { UserTokenPurpose } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { UnauthorizedError } from "../utils/errors.js";

/** One-time tokens for the flows that arrive by email.
 *
 *  Stored as hashes: the value goes in the message and nowhere else, so a
 *  leaked database does not hand over anyone's account. Each is usable exactly
 *  once and expires whether it is used or not.
 */

/** Short, because a reset link is a credential and a mailbox is not a vault. */
const TTL_MS: Record<UserTokenPurpose, number> = {
  [UserTokenPurpose.PASSWORD_RESET]: 60 * 60 * 1000,
  [UserTokenPurpose.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000,
};

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a token, invalidating any earlier one for the same purpose.
 *
 *  Superseding rather than accumulating: two live reset links for one account
 *  is one more than anybody needs, and the newest is the one the user is
 *  looking at.
 */
export async function issueUserToken(
  userId: string,
  purpose: UserTokenPurpose,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");

  await prisma.userToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.userToken.create({
    data: {
      tokenHash: hash(token),
      purpose,
      userId,
      expiresAt: new Date(Date.now() + TTL_MS[purpose]),
    },
  });

  return token;
}

/** Consumes a token, returning whose it was. Throws if it cannot be used. */
export async function consumeUserToken(
  token: string,
  purpose: UserTokenPurpose,
): Promise<string> {
  const record = await prisma.userToken.findUnique({
    where: { tokenHash: hash(token) },
  });

  // One message for every failure: which of "never existed", "already used"
  // and "expired" applies is not something a stranger should be able to learn.
  const invalid = new UnauthorizedError(
    "That link is no longer valid. Request a new one.",
    "INVALID_TOKEN",
  );

  if (!record || record.purpose !== purpose) throw invalid;
  if (record.usedAt) throw invalid;
  if (record.expiresAt.getTime() <= Date.now()) throw invalid;

  await prisma.userToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.userId;
}

/** Clears tokens that can no longer be used. */
export async function pruneUserTokens(): Promise<number> {
  const { count } = await prisma.userToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  return count;
}

export { UserTokenPurpose };
