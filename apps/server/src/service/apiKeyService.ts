import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_KEY_SCOPES,
  MAX_KEYS_PER_USER,
  MAX_KEY_LABEL,
  type ApiKeyScope,
  type ApiKeySummary,
  type CreatedApiKey,
} from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors.js";

/** Issuing, checking and revoking the credentials machines use.
 *
 *  Every design choice here follows from one fact: this thing lives on a CI
 *  runner for months, where nobody is looking at it. Hence a secret that is
 *  shown once and stored as a hash, a public prefix so a key can be named
 *  without the database holding anything usable, revocation that is a
 *  timestamp rather than a delete, and `lastUsedAt`, which is what makes
 *  revoking an unfamiliar key a safe thing to do rather than a gamble.
 */

/** `rc_` marks it as ours in a log or a leak scanner; the prefix names the
 *  key; the secret is the part that matters. Split by an underscore so the
 *  first two parts can be read off without knowing any lengths. */
const TOKEN_PREFIX = "rc";

/** Bytes of actual secret. 32 is what the email tokens use, and this is the
 *  credential with the longer life of the two. */
const SECRET_BYTES = 32;

/** How often `lastUsedAt` is written.
 *
 *  The question it answers is "is anything still using this key", which does
 *  not need second-level resolution — and a write per request would put a
 *  database round trip on every call this feature exists to make cheap.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time, because the alternative leaks how much of a guess was right
 *  one character at a time. Length is compared first because
 *  `timingSafeEqual` throws on a mismatch rather than returning false. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toSummary(row: {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiKeySummary {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: row.scopes.filter((scope): scope is ApiKeyScope =>
      (API_KEY_SCOPES as string[]).includes(scope),
    ),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every key an account has ever made, revoked ones included.
 *
 *  Revoked keys stay in the list on purpose: "that key was revoked on Tuesday"
 *  is the sentence somebody needs after an incident, and a list that quietly
 *  omits them cannot say it.
 */
export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return rows.map(toSummary);
}

/** Mints one, and returns the secret for the only time it will exist. */
export async function createApiKey(input: {
  userId: string;
  label: string;
  scopes: ApiKeyScope[];
  expiresInDays?: number;
}): Promise<CreatedApiKey> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > MAX_KEY_LABEL) {
    throw new BadRequestError("Give the key a name.", "BAD_LABEL");
  }

  // An empty scope list is a key that can do nothing, which is not a safer key
  // but a confusing one: it will fail on first use with a message about
  // permissions rather than about how it was made.
  if (input.scopes.length === 0) {
    throw new BadRequestError("Choose what this key may do.", "NO_SCOPES");
  }

  const live = await prisma.apiKey.count({
    where: { userId: input.userId, revokedAt: null },
  });
  if (live >= MAX_KEYS_PER_USER) {
    throw new ConflictError(
      `You already have ${String(MAX_KEYS_PER_USER)} live keys. Revoke one first.`,
      "KEY_LIMIT",
    );
  }

  const prefix = `${TOKEN_PREFIX}_${randomBytes(6).toString("hex")}`;
  // Hex, not base64url, and the reason is the separator: base64url's alphabet
  // includes `_`, so a secret encoded that way would sometimes contain the
  // character the three parts are split on. Fixing that in the parser would
  // work; not producing the ambiguity is better.
  const secret = `${prefix}_${randomBytes(SECRET_BYTES).toString("hex")}`;

  const row = await prisma.apiKey.create({
    data: {
      userId: input.userId,
      label,
      prefix,
      tokenHash: hash(secret),
      scopes: input.scopes,
      expiresAt:
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000),
    },
  });

  return { key: toSummary(row), secret };
}

/** Revokes one. Scoped to its owner in the WHERE clause rather than checked
 *  first: a filter that cannot match another person's row is a stronger thing
 *  than a check somebody has to remember to run. */
export async function revokeApiKey(
  userId: string,
  keyId: string,
): Promise<void> {
  const result = await prisma.apiKey.updateMany({
    where: { id: keyId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (result.count === 0) {
    throw new NotFoundError("No such key.", "KEY_NOT_FOUND");
  }
}

export interface VerifiedKey {
  userId: string;
  email: string;
  keyId: string;
  scopes: ApiKeyScope[];
}

/** Checks a presented secret, or refuses.
 *
 *  Every refusal says the same thing. A message distinguishing "no such key"
 *  from "revoked" from "expired" would tell somebody holding a stolen string
 *  which of those it is, and none of those facts is any use to the person who
 *  actually owns it — they are looking at the list, which says all three.
 */
export async function verifyApiKey(presented: string): Promise<VerifiedKey> {
  function refuse(): never {
    throw new UnauthorizedError("That API key is not valid.", "BAD_API_KEY");
  }

  const parts = presented.split("_");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) refuse();

  const prefix = `${parts[0]}_${parts[1]}`;

  const row = await prisma.apiKey.findUnique({
    where: { prefix },
    include: { user: { select: { email: true } } },
  });

  if (!row) refuse();
  if (!sameHash(row.tokenHash, hash(presented))) refuse();
  if (row.revokedAt !== null) refuse();
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) refuse();

  void touch(row.id, row.lastUsedAt);

  return {
    userId: row.userId,
    email: row.user.email,
    keyId: row.id,
    scopes: toSummary(row).scopes,
  };
}

/** Records that a key was used, at most once a minute, off the request path. */
async function touch(keyId: string, lastUsedAt: Date | null): Promise<void> {
  const now = Date.now();
  if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) {
    return;
  }

  try {
    await prisma.apiKey.update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(now) },
    });
  } catch (error) {
    // Losing a timestamp must never cost somebody a request that was valid.
    logger.error("could not record an API key's use", error, { keyId });
  }
}
