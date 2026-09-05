import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { isSecretBoxConfigured, open, seal } from "../lib/secretBox.js";
import {
  base32Encode,
  generateSecret,
  otpauthUrl,
  stepFor,
  verifyCode,
} from "../lib/totp.js";
import { BadRequestError, UnauthorizedError } from "../utils/errors.js";
import { increment } from "../lib/metrics.js";
import { logger } from "../lib/logger.js";

/** A second factor. plan.md §11.6.
 *
 *  §10.3 got the central thing right — sign-in stays even at n=1, because a
 *  server that issued a session to anybody who asked would be an
 *  unauthenticated server on whatever network it can be reached from. This is
 *  what that sentence needs once the network is the internet: the thing behind
 *  the password is not a document, it is `docker exec` on somebody's machine
 *  with their source tree mounted.
 *
 *  Deliberately NOT enforced. An operator on a laptop is protected by the
 *  network and does not need a phone to open their own editor, and a platform
 *  that decided otherwise would be making a threat-model judgement it is in no
 *  position to make. What it can do is make the stronger option available and
 *  make its state legible.
 */

/** How many recovery codes are issued, and how long each is.
 *
 *  Ten is the number every other implementation uses, which matters more than
 *  it sounds: it is how many lines somebody expects to see and to print. Five
 *  bytes each, which is exactly eight base32 characters -- enough that
 *  guessing is hopeless, short enough to transcribe from paper without an
 *  error.
 */
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 5;

export interface TwoFactorStatus {
  /** Whether a confirmed second factor is protecting this account. */
  enabled: boolean;
  /** Whether a setup was started and never confirmed. Reported rather than
   *  hidden: an unfinished enrolment is the state somebody is most likely to
   *  be stuck in, and a screen that shows "off" while a half-row exists gives
   *  them no way to understand why starting again behaves oddly. */
  pending: boolean;
  /** How many recovery codes are left. Zero with `enabled` true is a real and
   *  dangerous state — a lost phone is then a lost account — so it is a number
   *  rather than a boolean. */
  recoveryCodesLeft: number;
}

/** SHA-256, not argon2.
 *
 *  A recovery code is forty bits of server-chosen randomness, not a human
 *  password: there is no dictionary to attack and nothing for a slow hash to
 *  buy. This is the same reasoning `user_tokens` already applies to the tokens
 *  it puts in email, and the same function shape.
 */
function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

/** Codes are shown as `abcd-efgh` and typed back however people type them --
 *  with the hyphen or without, in either case, with a stray space from a
 *  paste. All of those are the same code, so all of them hash the same. */
function normaliseRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, "");
}

/** Lower case, because that is what a person copying from paper types, and
 *  `normaliseRecoveryCode` folds case anyway. */
function formatRecoveryCode(raw: string): string {
  const value = raw.toLowerCase();
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

/** Five random bytes as base32, which is exactly eight characters with no
 *  padding and no remainder -- 40 bits each.
 *
 *  Through the same encoder the TOTP secret uses rather than a hand-rolled
 *  alphabet: one that is not a power of two makes some codes very slightly
 *  likelier than others, and getting that subtly wrong in a second place is
 *  the kind of mistake nothing would ever report. */
function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    formatRecoveryCode(base32Encode(randomBytes(RECOVERY_CODE_BYTES))),
  );
}

export async function getTwoFactorStatus(
  userId: string,
): Promise<TwoFactorStatus> {
  const row = await prisma.userTwoFactor.findUnique({
    where: { userId },
    select: { confirmedAt: true, recoveryCodeHashes: true },
  });

  return {
    enabled: Boolean(row?.confirmedAt),
    pending: Boolean(row) && !row?.confirmedAt,
    recoveryCodesLeft: row?.confirmedAt ? row.recoveryCodeHashes.length : 0,
  };
}

/** Whether a sign-in has to ask for a code.
 *
 *  Confirmed only. An unconfirmed row is somebody who opened the setup screen
 *  and closed it, and treating that as protection would lock them out with a
 *  secret they never wrote down.
 */
export async function requiresSecondFactor(userId: string): Promise<boolean> {
  const row = await prisma.userTwoFactor.findUnique({
    where: { userId },
    select: { confirmedAt: true },
  });
  return Boolean(row?.confirmedAt);
}

/** What the authenticator app lists this account under.
 *
 *  The deployment's own hostname rather than a constant, and that is worth the
 *  three lines: somebody running this on a laptop and on a server would
 *  otherwise get two identical "Replit Clone" entries with the same email and
 *  no way to tell which code belongs to which.
 */
function issuer(): string {
  try {
    return new URL(env.WEB_ORIGIN).host;
  } catch {
    return "Replit Clone";
  }
}

export interface EnrolmentOffer {
  secret: string;
  otpauthUrl: string;
}

/** Starts enrolment, replacing any unfinished one.
 *
 *  Replacing rather than resuming, because the only way to reach here twice is
 *  to have lost or abandoned the first secret — and refusing would leave
 *  somebody permanently unable to start over.
 *
 *  It deliberately does NOT touch a CONFIRMED row: overwriting a working
 *  second factor with an unconfirmed one would turn "I clicked the wrong
 *  thing" into being locked out.
 */
export async function beginEnrolment(
  userId: string,
  account: string,
): Promise<EnrolmentOffer> {
  if (!isSecretBoxConfigured()) {
    throw new BadRequestError(
      "This server cannot store a second factor: SECRET_ENCRYPTION_KEY is " +
        "not set.",
      "SECRETS_UNCONFIGURED",
    );
  }

  const existing = await prisma.userTwoFactor.findUnique({
    where: { userId },
    select: { confirmedAt: true },
  });
  if (existing?.confirmedAt) {
    throw new BadRequestError(
      "Two-factor authentication is already on for this account. Turn it off " +
        "first if you want to enrol a different app.",
      "ALREADY_ENABLED",
    );
  }

  const secret = generateSecret();

  await prisma.userTwoFactor.upsert({
    where: { userId },
    create: { userId, secret: seal(secret), recoveryCodeHashes: [] },
    // Reset in full, so an abandoned enrolment leaves nothing of itself
    // behind -- particularly not a `lastUsedStep` from a different secret.
    update: {
      secret: seal(secret),
      confirmedAt: null,
      recoveryCodeHashes: [],
      lastUsedStep: null,
    },
  });

  return { secret, otpauthUrl: otpauthUrl({ secret, account, issuer: issuer() }) };
}

/** Finishes enrolment, and returns the recovery codes ONCE.
 *
 *  The code is required, and that is the entire point of this step: it proves
 *  the authenticator app really holds the secret. Enrolling without it means a
 *  mistyped setup locks the account on the next sign-in, which is the single
 *  most common way second factors go wrong.
 */
export async function confirmEnrolment(
  userId: string,
  code: string,
): Promise<string[]> {
  const row = await prisma.userTwoFactor.findUnique({ where: { userId } });
  if (!row) {
    throw new BadRequestError("Start setting up two-factor first.", "NO_ENROLMENT");
  }
  if (row.confirmedAt) {
    throw new BadRequestError(
      "Two-factor authentication is already on.",
      "ALREADY_ENABLED",
    );
  }

  const result = verifyCode(openSecret(row.secret), code);
  if (!result.ok) {
    increment("two_factor_failures");
    throw new BadRequestError(
      "That code did not match. Check your phone's clock is right, then try " +
        "the next one.",
      "BAD_CODE",
    );
  }

  const codes = newRecoveryCodes();

  await prisma.userTwoFactor.update({
    where: { userId },
    data: {
      confirmedAt: new Date(),
      recoveryCodeHashes: codes.map(hashRecoveryCode),
      lastUsedStep: BigInt(result.step ?? stepFor(Date.now())),
    },
  });

  logger.info("two-factor enabled", { userId });
  increment("two_factor_enabled");

  // The only time these exist in readable form. They are hashes from here on.
  return codes;
}

/** Turns it off. The caller is responsible for having re-checked the password:
 *  see the controller, which is where that belongs. */
export async function disableTwoFactor(userId: string): Promise<void> {
  await prisma.userTwoFactor.deleteMany({ where: { userId } });
  logger.info("two-factor disabled", { userId });
  increment("two_factor_disabled");
}

/** Issues a fresh set, invalidating the old.
 *
 *  Every implementation offers this and it is not a nicety: somebody who has
 *  used eight of ten codes, or who has left a printout somewhere they should
 *  not have, has no other move.
 */
export async function regenerateRecoveryCodes(
  userId: string,
): Promise<string[]> {
  const row = await prisma.userTwoFactor.findUnique({
    where: { userId },
    select: { confirmedAt: true },
  });
  if (!row?.confirmedAt) {
    throw new BadRequestError(
      "Two-factor authentication is not on for this account.",
      "NOT_ENABLED",
    );
  }

  const codes = newRecoveryCodes();
  await prisma.userTwoFactor.update({
    where: { userId },
    data: { recoveryCodeHashes: codes.map(hashRecoveryCode) },
  });

  return codes;
}

function openSecret(sealed: string): string {
  try {
    return open(sealed);
  } catch {
    // Sealed under a key this deployment no longer has. Unlike the signing
    // key, falling back to "no second factor" would be a downgrade attack in
    // one environment variable, so this fails closed.
    throw new UnauthorizedError(
      "This account's second factor cannot be read by this server.",
    );
  }
}

export type SecondFactorKind = "totp" | "recovery";

/** Checks a code at sign-in, and spends it.
 *
 *  Both kinds are checked here rather than on separate endpoints, because the
 *  person typing does not always know which they have — a recovery code and a
 *  TOTP code go in the same box, and telling them apart is the server's job.
 *
 *  Throws rather than returning false, so no caller can forget to look.
 */
export async function consumeSecondFactor(
  userId: string,
  code: string,
): Promise<SecondFactorKind> {
  const row = await prisma.userTwoFactor.findUnique({ where: { userId } });
  if (!row?.confirmedAt) {
    // Reachable only if the factor was turned off between the password step
    // and this one, which is a race rather than an attack -- but a session
    // must not be issued from a challenge nothing verified.
    throw new UnauthorizedError("Two-factor is not enabled for this account.");
  }

  const result = verifyCode(openSecret(row.secret), code);
  if (result.ok) {
    const step = BigInt(result.step ?? 0);

    // The replay guard. A code is valid for a whole window, so without this a
    // code seen once works again until that window ends.
    if (row.lastUsedStep !== null && step <= row.lastUsedStep) {
      increment("two_factor_replays");
      throw new UnauthorizedError(
        "That code has already been used. Wait for the next one.",
      );
    }

    await prisma.userTwoFactor.update({
      where: { userId },
      data: { lastUsedStep: step },
    });
    return "totp";
  }

  const spent = await spendRecoveryCode(userId, row.recoveryCodeHashes, code);
  if (spent) return "recovery";

  increment("two_factor_failures");
  throw new UnauthorizedError("That code is not right.");
}

/** Removes a matching recovery code, or reports that none matched.
 *
 *  Compared in constant time against every stored hash, and every hash is
 *  compared even after a match: returning early would leak, through timing,
 *  roughly how many codes have been used.
 */
async function spendRecoveryCode(
  userId: string,
  hashes: string[],
  code: string,
): Promise<boolean> {
  const given = Buffer.from(hashRecoveryCode(code), "hex");

  let matched = -1;
  for (let index = 0; index < hashes.length; index += 1) {
    const stored = Buffer.from(hashes[index] ?? "", "hex");
    if (
      stored.length === given.length &&
      timingSafeEqual(stored, given) &&
      matched === -1
    ) {
      matched = index;
    }
  }

  if (matched === -1) return false;

  await prisma.userTwoFactor.update({
    where: { userId },
    data: {
      recoveryCodeHashes: hashes.filter((_, index) => index !== matched),
    },
  });

  logger.warn("two-factor recovery code used", {
    userId,
    remaining: hashes.length - 1,
  });
  increment("two_factor_recovery_used");

  return true;
}
