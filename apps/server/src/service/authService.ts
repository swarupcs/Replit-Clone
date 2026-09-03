import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { assertCanCreateAccount } from "./singleUserService.js";
import { isAdminEmail } from "../middlewares/requireAdmin.js";
import { ConflictError, UnauthorizedError } from "../utils/errors.js";
import { increment } from "../lib/metrics.js";

export interface PublicUser {
  id: string;
  email: string;
  /** Whether this account is on `ADMIN_EMAILS`.
   *
   *  A hint for the interface, not a permission: it decides whether the client
   *  OFFERS the report queue. `requireAdmin` decides whether the queue opens,
   *  and re-reads the allowlist on every request. */
  isAdmin: boolean;
}

export function toPublicUser(user: { id: string; email: string }): PublicUser {
  // Read here rather than left for the client to guess. It only decides
  // whether the report queue is OFFERED -- `requireAdmin` decides whether it
  // opens -- so a stale or forged value costs a 403 and nothing else.
  return { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email) };
}

/** A real argon2id hash of a value nobody knows, so verifying against it costs
 *  the same as verifying a real one. Its only job is to take time. */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

export async function registerUser(
  email: string,
  password: string,
): Promise<PublicUser> {
  // One of the two places a `User` row is made, and so one of the two places
  // this is asked. See decision 16: a limit is checked where the thing is
  // CREATED and nowhere else.
  assertCanCreateAccount();

  const normalizedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (existing) {
    throw new ConflictError("An account with that email already exists");
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.user.create({
    data: { email: normalizedEmail, passwordHash },
  });

  return toPublicUser(user);
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<PublicUser> {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // Always verify against *something* so a missing account, an account with no
  // password, and a wrong password all take comparable time and cannot be told
  // apart by timing.
  const hash = user?.passwordHash ?? DUMMY_HASH;

  let valid = false;
  try {
    valid = await argon2.verify(hash, password);
  } catch {
    valid = false;
  }

  if (!user || !user.passwordHash || !valid) {
    increment("auth_failures");
    throw new UnauthorizedError("Incorrect email or password");
  }

  return toPublicUser(user);
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  return user ? toPublicUser(user) : null;
}
