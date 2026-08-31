import type {
  ModerationAction as ApiAction,
  ModerationActionType,
} from "@replit-clone/shared";
import { MAX_APPEAL, MAX_MODERATION_REASON } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";
import { notify, notifyAdmins } from "./notificationService.js";
import { webUrl } from "../lib/mailer.js";

/** The moderation trail, and the appeal that answers it.
 *
 *  Two things live here rather than one, because they are one conversation.
 *  §2.16 made a takedown stick — the owner can no longer publish again — and
 *  that removed the property §6 decision 11 leaned on when it argued the
 *  moderation authority was safe *because* its subject could undo a mistake.
 *  The trade was right; a takedown the owner can reverse is not a takedown.
 *  What it left behind is an unreviewed power with no route back, and the
 *  appeal is that route.
 *
 *  Nothing here can take a project down. Recording and appealing are kept
 *  apart from deciding on purpose: `reportService` owns the decision, this
 *  owns the account of it.
 */

/** Prisma's transaction client, as narrowly as this file needs it.
 *
 *  Typed structurally rather than by importing the generated type: the client
 *  is regenerated into `src/generated`, and naming its transaction type here
 *  would tie this file to that path for no benefit.
 */
interface ModerationEntry {
  projectId: string;
  projectName: string;
  reportId: string | null;
  action: ModerationActionType;
  actor: string;
  reason: string | null;
}

interface Tx {
  moderationAction: {
    create: (args: { data: ModerationEntry }) => Promise<unknown>;
  };
}

/** Writes one entry, inside somebody else's transaction.
 *
 *  Takes the transaction client rather than using `prisma` directly so that a
 *  decision and the record of it commit together. An audit log that can be
 *  missing the entry for the action it exists to describe is not an audit log,
 *  and the gap would appear exactly when the write failed — which is when
 *  somebody most wants to know what happened.
 */
export async function recordModeration(
  tx: Tx,
  entry: {
    projectId: string;
    projectName: string;
    reportId?: string | null;
    action: ModerationActionType;
    actor: string;
    reason?: string | null;
  },
): Promise<void> {
  await tx.moderationAction.create({
    data: {
      projectId: entry.projectId,
      projectName: entry.projectName,
      reportId: entry.reportId ?? null,
      action: entry.action,
      actor: entry.actor,
      reason: entry.reason ?? null,
    },
  });
}

function toApi(row: {
  id: string;
  projectId: string | null;
  projectName: string;
  reportId: string | null;
  action: string;
  actor: string;
  reason: string | null;
  createdAt: Date;
}): ApiAction {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.projectName,
    reportId: row.reportId,
    action: row.action as ModerationActionType,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One project's trail, oldest first.
 *
 *  Oldest first, unlike every other list in this codebase, because this one is
 *  a sequence rather than a feed. "Taken down, appealed, reinstated" only
 *  means anything read in the order it happened.
 */
export async function listModerationActions(
  projectId: string,
): Promise<ApiAction[]> {
  const rows = await prisma.moderationAction.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toApi);
}

/** Everything recent, for an operator with no particular project in mind. */
export async function listRecentModeration(limit = 100): Promise<ApiAction[]> {
  const rows = await prisma.moderationAction.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map(toApi);
}

/** The owner asking for a takedown to be looked at again.
 *
 *  Refused unless there is something to appeal, and refused while one is
 *  already open. The second is not tidiness: an appeal is a message to a human
 *  who may be the only operator on the deployment, so an owner able to file a
 *  hundred is an owner able to bury everybody else's — the same scarce-resource
 *  argument the report queue's unique index makes.
 */
export async function appealTakedown(input: {
  projectId: string;
  ownerId: string;
  text: string;
}): Promise<ApiAction> {
  const text = input.text.trim();

  if (text.length === 0) {
    throw new BadRequestError("Say why it should be put back.", "APPEAL_EMPTY");
  }

  if (text.length > MAX_APPEAL) {
    throw new BadRequestError(
      `Keep the appeal under ${String(MAX_APPEAL)} characters.`,
      "APPEAL_TOO_LONG",
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, name: true, ownerId: true, takenDownAt: true },
  });

  if (!project) throw new NotFoundError("No such project.", "NOT_FOUND");

  // The owner's alone, and not delegated with edit access. A collaborator is
  // not the person the takedown was made against.
  if (project.ownerId !== input.ownerId) {
    throw new ForbiddenError("Only the project's owner can appeal.", "NOT_OWNER");
  }

  if (!project.takenDownAt) {
    throw new BadRequestError(
      "This project has not been taken down.",
      "NOT_TAKEN_DOWN",
    );
  }

  const previous = await prisma.moderationAction.findFirst({
    where: { projectId: project.id, action: "APPEALED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  // Compared against the CURRENT takedown, not merely "has ever appealed". A
  // project taken down, reinstated, and taken down again is a new case, and
  // the owner is entitled to answer it.
  if (previous && previous.createdAt > project.takenDownAt) {
    throw new BadRequestError(
      "You have already appealed. Somebody will look at it.",
      "ALREADY_APPEALED",
    );
  }

  const owner = await prisma.user.findUnique({
    where: { id: input.ownerId },
    select: { email: true },
  });

  const row = await prisma.moderationAction.create({
    data: {
      projectId: project.id,
      projectName: project.name,
      action: "APPEALED",
      actor: owner?.email ?? input.ownerId,
      reason: text,
    },
  });

  increment("moderation_appealed");

  await notifyAdmins({
    subject: `Appeal: ${project.name}`,
    text:
      `${owner?.email ?? "The owner"} is appealing the takedown of ` +
      `"${project.name}".\n\nWhat they wrote:\n${text}\n\n` +
      `The queue is here:\n${webUrl("/admin/reports", {})}`,
  });

  return toApi(row);
}

/** An operator lifting a takedown.
 *
 *  Clears `takenDownAt` and stops there. It does NOT make the project public
 *  again: reinstating restores the owner's control of that switch, and what to
 *  do with it is theirs to decide. It does not bring a site back either — the
 *  files and the container were removed, and only a new publish restores one.
 *  Both are said in the notification rather than left to be discovered.
 */
export async function reinstateProject(input: {
  projectId: string;
  actor: string;
  reason: string;
}): Promise<ApiAction> {
  const reason = input.reason.trim();

  // Required, unlike the reason on a decision. "We put it back" with no
  // account of why is the half of the record that makes the other half
  // unfalsifiable — and of every action here this is the one an operator has
  // the most reason to leave unexplained.
  if (reason.length === 0) {
    throw new BadRequestError("Say why it is being put back.", "REASON_REQUIRED");
  }

  if (reason.length > MAX_MODERATION_REASON) {
    throw new BadRequestError(
      `Keep the reason under ${String(MAX_MODERATION_REASON)} characters.`,
      "REASON_TOO_LONG",
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, name: true, ownerId: true, takenDownAt: true },
  });

  if (!project) throw new NotFoundError("No such project.", "NOT_FOUND");

  if (!project.takenDownAt) {
    throw new BadRequestError(
      "This project has not been taken down.",
      "NOT_TAKEN_DOWN",
    );
  }

  const row = await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: project.id },
      data: { takenDownAt: null },
    });

    return tx.moderationAction.create({
      data: {
        projectId: project.id,
        projectName: project.name,
        action: "REINSTATED",
        actor: input.actor,
        reason,
      },
    });
  });

  increment("moderation_reinstated");
  logger.info("project reinstated", {
    projectId: project.id,
    actor: input.actor,
  });

  await notify({
    userId: project.ownerId,
    kind: "PROJECT_REINSTATED",
    title: `"${project.name}" has been reinstated`,
    body:
      `A moderator lifted the takedown on "${project.name}". It is private, ` +
      `and yours to publish again if you want to. A site you had published ` +
      `was removed and will need deploying again.`,
    link: `/project/${project.id}`,
  });

  return toApi(row);
}
