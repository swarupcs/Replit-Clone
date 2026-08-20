import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { UnauthorizedError } from "../utils/errors.js";
import {
  refreshCookieMaxAgeMs,
  signRefreshToken,
  verifyRefreshToken,
} from "./tokenService.js";

/** Server-side record of every issued refresh token.
 *
 *  A valid signature used to be the whole check, which made sign-out cosmetic:
 *  it cleared the browser's cookie and nothing else, so anyone holding the
 *  value kept a working session for its full lifetime. Rotating the signing
 *  secret was the only way to end a session, and it ended everyone's.
 *
 *  Tokens now rotate on every use and are stored as hashes. Presenting one that
 *  has already been rotated is a replay — the holder cannot be distinguished
 *  from a thief, so the whole family is revoked and both parties have to sign
 *  in again.
 */

/** The stored form. Never the token itself, so a leaked backup does not hand
 *  over live sessions. */
function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
}

/** Issues the first token of a new family, i.e. a fresh sign-in. */
export async function issueRefreshToken(
  userId: string,
): Promise<IssuedRefreshToken> {
  return persist(userId, randomUUID());
}

async function persist(
  userId: string,
  familyId: string,
): Promise<IssuedRefreshToken> {
  const token = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      tokenHash: hash(token),
      userId,
      familyId,
      expiresAt: new Date(Date.now() + refreshCookieMaxAgeMs),
    },
  });

  return { token, familyId };
}

/** Verifies a presented token and replaces it with a successor.
 *
 *  Rejects anything whose signature fails, that was never issued, that has
 *  already been used, or that has expired.
 */
export async function rotateRefreshToken(
  presented: string,
): Promise<{ userId: string; token: string }> {
  // Signature first: an unsigned value is not worth a database round trip.
  const { sub: userId } = verifyRefreshToken(presented);

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hash(presented) },
  });

  if (!record) {
    // Correctly signed but unknown: either it was issued before tokens were
    // recorded, or the family has since been cleaned up. Neither is a session
    // we are willing to continue.
    throw new UnauthorizedError("Session is no longer valid");
  }

  if (record.revokedAt) {
    // Replay. The legitimate holder and whoever else has the value cannot be
    // told apart, so end every session descended from this sign-in.
    await revokeFamily(record.familyId);
    throw new UnauthorizedError("Session was reused and has been revoked");
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError("Session has expired");
  }

  // Marked revoked, not deleted: a replay has to remain detectable.
  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });

  const { token } = await persist(record.userId, record.familyId);
  return { userId: record.userId, token };
}

/** Ends the session a token belongs to. Used by sign-out. */
export async function revokeRefreshToken(presented: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({
      where: { tokenHash: hash(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    // Signing out must succeed even for a token that was never valid; the
    // cookie is cleared either way.
    .catch(() => undefined);
}

export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Ends every session for a user. */
export async function revokeAllForUser(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Clears rows that can no longer authorise anything.
 *
 *  Revoked rows are kept for a grace period so a replay is still detected
 *  rather than silently reported as "never issued".
 */
const REPLAY_GRACE_MS = 24 * 60 * 60 * 1000;

export async function pruneExpiredRefreshTokens(): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      expiresAt: { lt: new Date(Date.now() - REPLAY_GRACE_MS) },
    },
  });

  return count;
}
