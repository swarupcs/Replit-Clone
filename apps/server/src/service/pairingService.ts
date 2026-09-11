import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { increment } from "../lib/metrics.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { ProjectRole } from "../generated/prisma/client.js";
import { type PairingClaims, signPairingToken } from "./tokenService.js";
import type { AccessLevel, ProjectAccess } from "./projectAccessService.js";

/** Pairing somebody in without an account. plan.md §13.6.
 *
 *  The collaborative layer — Yjs per file, awareness, remote cursors, presence,
 *  follow mode — is finished, and reaching it required being a row in
 *  `ProjectCollaborator`. Even the EDITOR share link is "a named grant":
 *  redeeming it adds the signed-in user as a collaborator, so the person on the
 *  other end signs up first. Right for a platform; wrong for ten minutes of
 *  pairing, which is what that layer is most obviously for.
 *
 *  **Redeeming writes no collaborator row.** It mints a scoped, expiring guest
 *  identity — a thing this codebase already knew how to do twice, since preview
 *  and MFA tokens are both typed, short-lived and checked on verify. The guest
 *  never becomes an account, never appears in the collaborator list, and cannot
 *  outlive their token, so the owner has nothing to remember to revoke.
 */

/** A link is a bearer string, so it has to be unguessable. 32 bytes of
 *  randomness, base64url — the same shape and source the share token uses. */
function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface InviteSummary {
  id: string;
  token: string;
  role: ProjectRole;
  label: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  redeemedCount: number;
  createdAt: Date;
}

const INVITE_FIELDS = {
  id: true,
  token: true,
  role: true,
  label: true,
  expiresAt: true,
  revokedAt: true,
  redeemedCount: true,
  createdAt: true,
} as const;

export async function createPairingInvite(
  projectId: string,
  createdById: string,
  options: { role?: ProjectRole; label?: string } = {},
): Promise<InviteSummary> {
  const expiresAt = new Date(Date.now() + env.PAIRING_INVITE_TTL_HOURS * 60 * 60 * 1000);

  return prisma.pairingInvite.create({
    data: {
      token: newInviteToken(),
      projectId,
      createdById,
      role: options.role ?? ProjectRole.EDITOR,
      // Somebody else reads this in a list; bounded here rather than wherever
      // it is finally rendered.
      label: options.label?.slice(0, 100) ?? null,
      expiresAt,
    },
    select: INVITE_FIELDS,
  });
}

export async function listPairingInvites(projectId: string): Promise<InviteSummary[]> {
  return prisma.pairingInvite.findMany({
    where: { projectId },
    select: INVITE_FIELDS,
    orderBy: { createdAt: "desc" },
  });
}

/** Ends a link.
 *
 *  **Stamped rather than deleted**, so the row survives as a record of what was
 *  granted and when it stopped. Guests already holding a token keep it until it
 *  expires — revoking closes the door, it does not reach through it — and
 *  `PAIRING_TOKEN_TTL_HOURS` is the bound on how long that is.
 */
export async function revokePairingInvite(
  projectId: string,
  inviteId: string,
): Promise<void> {
  const { count } = await prisma.pairingInvite.updateMany({
    // projectId in the WHERE: an invite belonging to another project cannot be
    // revoked by guessing its id from a project you do own.
    where: { id: inviteId, projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (count === 0) throw new NotFoundError("No such pairing link.", "INVITE_NOT_FOUND");
}

export interface RedeemedPairing {
  token: string;
  projectId: string;
  projectName: string;
  role: ProjectRole;
  guestId: string;
  displayName: string;
  expiresInHours: number;
}

/** What a guest gets for a link.
 *
 *  Every reason to refuse produces the SAME sentence. A link that says
 *  "expired" rather than "not valid" tells whoever holds it that it was once
 *  real and that this project exists — so the distinctions live in the metrics
 *  and not in the response.
 */
export async function redeemPairingInvite(
  rawToken: string,
  requestedName: string | undefined,
  now = new Date(),
): Promise<RedeemedPairing> {
  const token = rawToken.trim();
  if (!token) throw new NotFoundError("That pairing link is not valid.", "INVITE_INVALID");

  const invite = await prisma.pairingInvite.findUnique({
    where: { token },
    include: {
      project: { select: { id: true, name: true, takenDownAt: true, deletedAt: true } },
    },
  });

  // `takenDownAt` and `deletedAt` are checked here for the reason §6 decision
  // 13 gives: a moderated project must stop handing out a container to run its
  // code in, and a guarantee that depends on a cleanup having succeeded is not
  // a guarantee.
  const usable =
    invite !== null &&
    invite.revokedAt === null &&
    invite.expiresAt > now &&
    invite.project.takenDownAt === null &&
    invite.project.deletedAt === null;

  if (!usable) {
    increment("pairing_redeem_refused");
    throw new NotFoundError("That pairing link is not valid.", "INVITE_INVALID");
  }

  await prisma.pairingInvite.update({
    where: { id: invite.id },
    data: { redeemedCount: { increment: 1 } },
  });

  const guestId = `guest_${randomUUID()}`;
  const displayName = guestName(requestedName);

  const claims: PairingClaims = {
    sub: guestId,
    pid: invite.projectId,
    role: invite.role === ProjectRole.VIEWER ? "VIEWER" : "EDITOR",
    nam: displayName,
  };

  increment("pairing_redeemed");

  return {
    token: signPairingToken(claims),
    projectId: invite.projectId,
    projectName: invite.project.name,
    role: invite.role,
    guestId,
    displayName,
    expiresInHours: env.PAIRING_TOKEN_TTL_HOURS,
  };
}

/** The lowest code point that is not a control character, and the one that is.
 *
 *  Compared numerically rather than matched with a regex literal: a character
 *  class of control characters means putting control characters in the source,
 *  and a file nobody can paste safely is worse than two constants.
 */
const FIRST_PRINTABLE = 0x20;
const DELETE_CHARACTER = 0x7f;

/** What to call somebody who has not told us who they are.
 *
 *  Theirs to choose and never trusted as an identity: bounded, stripped of
 *  control characters, and given a default rather than being allowed to be
 *  empty. It reaches other people's presence cursors, so it is somebody else's
 *  text inside this deployment's UI.
 */
export function guestName(requested: string | undefined): string {
  const cleaned = Array.from(requested ?? "")
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= FIRST_PRINTABLE && code !== DELETE_CHARACTER;
    })
    .join("")
    .trim()
    .slice(0, 40);

  return cleaned.length > 0 ? cleaned : "Guest";
}

/** The access a pairing token grants, or nothing.
 *
 *  **The project is compared against the token's own `pid`.** A pairing
 *  credential is good for one project, and this is where that is enforced: a
 *  guest presenting a valid token for project A against project B gets `null`,
 *  exactly as a stranger would.
 */
export async function pairingAccess(
  claims: PairingClaims,
  projectId: string,
): Promise<ProjectAccess | null> {
  if (claims.pid !== projectId) return null;

  const project = await prisma.project.findFirst({
    where: { id: projectId, takenDownAt: null, deletedAt: null },
  });
  if (!project) return null;

  const level: AccessLevel = claims.role === "EDITOR" ? "editor" : "viewer";
  return { project, level };
}

/** Removes links nobody can use any more.
 *
 *  Expired and revoked rows are already refused by `redeemPairingInvite` — this
 *  is housekeeping rather than a security boundary, which is why it can be a
 *  sweep that is allowed to fail.
 */
export async function sweepPairingInvites(now = new Date()): Promise<number> {
  // A week after it stopped working, so the owner's list still explains what
  // happened for a few days rather than silently emptying.
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { count } = await prisma.pairingInvite.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });

  return count;
}

export function assertRole(value: unknown): ProjectRole {
  if (value === "VIEWER") return ProjectRole.VIEWER;
  if (value === "EDITOR" || value === undefined) return ProjectRole.EDITOR;
  throw new BadRequestError("A pairing link is VIEWER or EDITOR.", "BAD_ROLE");
}
