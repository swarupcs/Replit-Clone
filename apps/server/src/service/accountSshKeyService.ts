import type { SshKey } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { BadRequestError } from "../utils/errors.js";
import { parseSshPublicKeys } from "../lib/sshPublicKey.js";

/** The public keys an account may open its workspaces with. plan.md §10.1
 *  Route C.
 *
 *  On the account rather than on a project, and that is the whole shape of the
 *  feature: a person has a laptop, the laptop has a key, and every workspace
 *  they own should open with it. A key per project would be a key to rotate
 *  per project, which is the version of rotation that does not happen — the
 *  same argument §13.8 makes for secrets.
 *
 *  Stored in the clear, deliberately. A public key is public: sealing it would
 *  imply a confidentiality it does not have, and an operator reading the column
 *  to answer "who can log into this box" is a legitimate question with a
 *  legitimate answer.
 */

/** Enough to be a real limit and not enough to be a denial of service against
 *  the file this is written into. Six machines is already generous for one
 *  person, which is who this is for. */
const MAX_KEYS = 10;

export async function getAccountSshKeys(userId: string): Promise<SshKey[]> {
  const row = await prisma.userPersonalization.findUnique({
    where: { userId },
    select: { sshKeys: true },
  });

  const stored = row?.sshKeys;
  if (!Array.isArray(stored)) return [];

  try {
    // Re-parsed on the way out rather than trusted. The rules can tighten --
    // this file already refuses a key type OpenSSH itself has dropped -- and a
    // row written under looser rules should stop being served, not keep
    // working because it is already in the database.
    return parseSshPublicKeys(stored.filter((entry): entry is string => typeof entry === "string"));
  } catch (error) {
    logger.warn("stored ssh keys could not be parsed", { userId, error });
    return [];
  }
}

export async function setAccountSshKeys(
  userId: string,
  lines: unknown,
): Promise<SshKey[]> {
  if (!Array.isArray(lines)) {
    throw new BadRequestError("Expected a list of public keys");
  }

  const raw = lines.map((entry) => {
    if (typeof entry !== "string") {
      throw new BadRequestError("Each key must be a single line of text");
    }
    return entry;
  });

  // Throws with a message naming what is wrong with the line. Validated in
  // full before anything is written, so a paste of six keys with one typo
  // stores none of them rather than five.
  const keys = parseSshPublicKeys(raw);

  if (keys.length > MAX_KEYS) {
    throw new BadRequestError(`At most ${String(MAX_KEYS)} keys`);
  }

  const stored = keys.map((key) => key.line);

  await prisma.userPersonalization.upsert({
    where: { userId },
    create: { userId, sshKeys: stored },
    update: { sshKeys: stored },
  });

  return keys;
}

/** The keys a project's container should accept.
 *
 *  The OWNER's keys, and only the owner's. A collaborator with editor access
 *  can already open a terminal in this container through the browser, so this
 *  is not a new capability in kind -- but an SSH key is a credential that
 *  outlives a session and a revocation, and handing one workspace's shell to
 *  everybody who was ever added to it is not something to arrive at by
 *  accident. If sharing an attachable workspace is wanted later, it should be
 *  its own row with its own decision, not a quiet `OR` here.
 *
 *  Never throws: an editor you can attach is an addition to a workspace, not a
 *  precondition for one.
 */
export async function accountSshKeys(projectId: string): Promise<SshKey[]> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!project) return [];

    return await getAccountSshKeys(project.ownerId);
  } catch (error) {
    logger.warn("could not read ssh keys for a project", { projectId, error });
    return [];
  }
}
