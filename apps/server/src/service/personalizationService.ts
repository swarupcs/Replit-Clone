import type {
  Personalization,
  PersonalizationUpdate,
} from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { BadRequestError } from "../utils/errors.js";
import { resolveTarget, validateRepoUrl } from "../containers/dotfiles.js";

/** One account's dotfiles. plan.md §11.9.
 *
 *  A service of its own rather than three more fields on `accountService`,
 *  because the two answer different questions: that one reports what an
 *  account is USING against what it is allowed, and this one holds what the
 *  account has ASKED FOR. Only the second is writable, and only the second
 *  holds anything that must never be read back.
 */

/** Longest install command accepted. Long enough for a real one-liner, short
 *  enough that nobody is storing a program in a settings field. */
const MAX_INSTALL_LENGTH = 500;

/** What the API hands back.
 *
 *  Written as an explicit projection rather than a spread of the row, and that
 *  is the point: the same table will hold a signing private key, and a spread
 *  would carry it into a JSON response the first time somebody added a column.
 *  This function drops what must not be returned by never naming it.
 */
function toPersonalization(
  row: {
    dotfilesRepo: string | null;
    dotfilesTarget: string | null;
    dotfilesInstall: string | null;
  } | null,
): Personalization {
  return {
    dotfilesRepo: row?.dotfilesRepo ?? null,
    dotfilesTarget: row?.dotfilesTarget ?? null,
    dotfilesInstall: row?.dotfilesInstall ?? null,
  };
}

/** An account with no row has defaults, not an error.
 *
 *  The row is created on first write. Every account that existed before this
 *  table did therefore reads as "nothing set", which is what it is. */
export async function getPersonalization(
  userId: string,
): Promise<Personalization> {
  const row = await prisma.userPersonalization.findUnique({
    where: { userId },
    select: {
      dotfilesRepo: true,
      dotfilesTarget: true,
      dotfilesInstall: true,
    },
  });
  return toPersonalization(row);
}

/** The dotfiles settings, for the container layer.
 *
 *  Separate from `getPersonalization` because the shapes are different on
 *  purpose: this one is the three fields a clone needs, and returns null when
 *  there is nothing to do, so the caller cannot accidentally treat "no
 *  dotfiles" as "dotfiles at the empty URL".
 */
export async function dotfilesFor(userId: string): Promise<{
  repo: string;
  target: string | null;
  install: string | null;
} | null> {
  const row = await prisma.userPersonalization.findUnique({
    where: { userId },
    select: {
      dotfilesRepo: true,
      dotfilesTarget: true,
      dotfilesInstall: true,
    },
  });

  if (!row?.dotfilesRepo) return null;
  return {
    repo: row.dotfilesRepo,
    target: row.dotfilesTarget,
    install: row.dotfilesInstall,
  };
}

/** Normalises one nullable text field of an update.
 *
 *  `undefined` means "not mentioned" and is returned unchanged so the caller
 *  can leave the column alone; an empty string means "clear it" and becomes
 *  null. Without this, a form that submits every field as a string would only
 *  ever be able to SET things.
 */
function optionalText(
  value: string | null | undefined,
  validate?: (input: string) => string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!validate) return trimmed;
  try {
    return validate(trimmed);
  } catch (error) {
    throw new BadRequestError((error as Error).message, "INVALID_SETTING");
  }
}

export async function updatePersonalization(
  userId: string,
  update: PersonalizationUpdate,
): Promise<Personalization> {
  const data: {
    dotfilesRepo?: string | null;
    dotfilesTarget?: string | null;
    dotfilesInstall?: string | null;
  } = {};

  const repo = optionalText(update.dotfilesRepo, validateRepoUrl);
  if (repo !== undefined) data.dotfilesRepo = repo;

  // Validated through the same function the clone resolves with, so the rule
  // that refuses /home/sandbox/app is stated once. A second copy of it here
  // would be a second copy that could disagree.
  const target = optionalText(update.dotfilesTarget, (value) => {
    resolveTarget(value);
    return value;
  });
  if (target !== undefined) data.dotfilesTarget = target;

  const install = optionalText(update.dotfilesInstall, (value) => {
    if (value.length > MAX_INSTALL_LENGTH) {
      throw new Error(
        `An install command has to be under ${String(MAX_INSTALL_LENGTH)} characters.`,
      );
    }
    return value;
  });
  if (install !== undefined) data.dotfilesInstall = install;

  await prisma.userPersonalization.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  return getPersonalization(userId);
}
