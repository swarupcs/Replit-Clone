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
/** How long after a token is spent a second presentation is still treated as
 *  the same session rather than a theft.
 *
 *  Two browser tabs whose access tokens expire together each present the same
 *  cookie, seconds apart — as does one tab whose refresh response was lost on
 *  the way back. Without this both are indistinguishable from a replay, so
 *  the family is revoked and the user is signed out of everything for doing
 *  nothing but leaving a second tab open. That is frequent enough that the
 *  honest end of it is deployments turning rotation off altogether.
 *
 *  The cost is stated plainly: a stolen token used inside this window is
 *  accepted. It is deliberately a few seconds, and detection outside it is
 *  unchanged — the family still goes.
 */
const REUSE_GRACE_MS = 10_000;

export async function rotateRefreshToken(
  presented: string,
): Promise<{ userId: string; token: string }> {
  // Signature first: an unsigned value is not worth a database round trip.
  // The subject is deliberately taken from the stored row rather than the
  // token, so a valid signature cannot assert a different user than the one
  // the row was issued to.
  verifyRefreshToken(presented);

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hash(presented) },
  });

  if (!record) {
    // Correctly signed but unknown: either it was issued before tokens were
    // recorded, or the family has since been cleaned up. Neither is a session
    // we are willing to continue.
    throw new UnauthorizedError("Session is no longer valid");
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError("Session has expired");
  }

  // Claiming the row IS the check, rather than a separate read followed by a
  // write. Reading `revokedAt` and then updating let two concurrent refreshes
  // both see it null, both proceed, and both mint a live successor — so a
  // replay went undetected exactly when it mattered. Only one caller can move
  // this from null.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (claimed.count === 0) {
    await assertWithinReuseGrace(record.id, record.familyId);
  }

  const { token } = await persist(record.userId, record.familyId);
  return { userId: record.userId, token };
}

/** Decides whether a token that was already spent is a retry or a theft.
 *
 *  Two things have to hold for it to count as a retry, and the second is not
 *  optional. Time alone cannot tell a straggling second tab from someone who
 *  has just signed out: both spend the row, and both stamp `revokedAt` with
 *  the current time. Signing out has to end the session at once — that is the
 *  whole point of the record — so grace additionally requires the FAMILY to
 *  still hold a live token, meaning the session it belongs to is genuinely
 *  still running.
 *
 *  Rotation leaves a live successor behind; signing out, revoking a family and
 *  ending every session for a user all leave none. That is the discriminator.
 *
 *  Re-read rather than trusting the row we started with: another request may
 *  have spent it between that read and the claim, which is the whole race this
 *  exists for.
 */
async function assertWithinReuseGrace(
  id: string,
  familyId: string,
): Promise<void> {
  const current = await prisma.refreshToken.findUnique({ where: { id } });
  const spentAt = current?.revokedAt?.getTime();
  const recent = spentAt !== undefined && Date.now() - spentAt <= REUSE_GRACE_MS;

  if (recent) {
    const stillRunning = await prisma.refreshToken.count({
      where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    if (stillRunning > 0) return;
  }

  // A replay. The legitimate holder and whoever else has the value cannot be
  // told apart, so end every session descended from this sign-in.
  await revokeFamily(familyId);
  throw new UnauthorizedError("Session was reused and has been revoked");
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
