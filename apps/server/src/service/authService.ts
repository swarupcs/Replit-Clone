import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { ConflictError, UnauthorizedError } from "../utils/errors.js";

export interface PublicUser {
  id: string;
  email: string;
}

function toPublicUser(user: { id: string; email: string }): PublicUser {
  return { id: user.id, email: user.email };
}

export async function registerUser(
  email: string,
  password: string,
): Promise<PublicUser> {
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

  // Always verify against *something* so a missing account and a wrong
  // password take comparable time and cannot be distinguished by timing.
  const hash =
    user?.passwordHash ??
    "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

  let valid = false;
  try {
    valid = await argon2.verify(hash, password);
  } catch {
    valid = false;
  }

  if (!user || !valid) {
    throw new UnauthorizedError("Incorrect email or password");
  }

  return toPublicUser(user);
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  return user ? toPublicUser(user) : null;
}
