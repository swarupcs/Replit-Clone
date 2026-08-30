import type { NotificationKind } from "@replit-clone/shared";
import { NOTIFICATIONS_KEPT, NOTIFICATIONS_PAGE } from "@replit-clone/shared";
import { prisma } from "../lib/prisma.js";
import { getMailer, hasRealMailer, webUrl } from "../lib/mailer.js";
import { adminEmails } from "../middlewares/requireAdmin.js";
import { logger } from "../lib/logger.js";
import { increment } from "../lib/metrics.js";

/** Telling people things.
 *
 *  Two audiences with two different mechanisms, and the split is forced rather
 *  than chosen. A **user** has a row in `users`, so their news is stored and
 *  shown in the app, and mailed as well when that is possible. A **moderator**
 *  is an address in `ADMIN_EMAILS` and need not have an account at all, so
 *  there is nothing to store against and mail is the only channel there is.
 *
 *  Nothing in here throws at its caller. A notification is a side effect of
 *  something that already happened — a job that already ran, a project already
 *  made private — and failing that work because the announcement about it
 *  could not be written would be the tail wagging the dog. Every entry point
 *  catches and logs.
 */

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** A path in the web app. Turned into an absolute URL for mail, kept
   *  relative for the in-app list, which is already inside the app. */
  link?: string;
}

/** Records a notification, and mails it if mail is possible.
 *
 *  Resolves to the row's id, or null when nothing could be stored. Callers are
 *  not expected to check: the return exists for tests and for the rare caller
 *  that wants to log the connection.
 */
export async function notify(input: NotifyInput): Promise<string | null> {
  try {
    const row = await prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
      },
      select: { id: true },
    });

    increment("notifications_created");

    // Mail is attempted after the record exists, and its failure is not the
    // record's failure. The in-app copy is the one that is guaranteed to have
    // worked, which is the whole reason it is written first.
    await mailIfPossible(row.id, input);
    await prune(input.userId);

    return row.id;
  } catch (error) {
    logger.error("could not record a notification", error, {
      userId: input.userId,
      kind: input.kind,
    });
    return null;
  }
}

/** Sends the same news to whoever moderates, by mail only.
 *
 *  An empty `ADMIN_EMAILS` is a misconfiguration and says so, for the same
 *  reason the logging mailer shouts in production: a review queue nobody is
 *  told about is the exact condition this work exists to end, and it must not
 *  be reachable by leaving a variable unset and hearing nothing.
 */
export async function notifyAdmins(mail: {
  subject: string;
  text: string;
}): Promise<void> {
  const recipients = [...adminEmails()];

  if (recipients.length === 0) {
    logger.warn(
      "something needs a moderator's attention and ADMIN_EMAILS is empty, " +
        "so nobody was told",
      { subject: mail.subject },
    );
    return;
  }

  for (const to of recipients) {
    try {
      await getMailer().send({ to, subject: mail.subject, text: mail.text });
    } catch (error) {
      // One bad address must not cost the other moderators their mail.
      logger.error("could not mail a moderator", error, { to });
    }
  }
}

/** Mails a notification to its owner, when that is both possible and right.
 *
 *  Three separate gates, and the third is the one worth naming: mail goes only
 *  to a **verified** address. `emailVerifiedAt` exists precisely so that an
 *  address nobody has confirmed — which may belong to somebody else entirely,
 *  since signing up does not prove you own what you typed — is not sent
 *  another person's project news.
 */
async function mailIfPossible(id: string, input: NotifyInput): Promise<void> {
  if (!hasRealMailer()) return;

  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, emailVerifiedAt: true },
    });

    if (!user?.emailVerifiedAt) return;

    const link = input.link
      ? `\n\n${webUrl(input.link, {})}`
      : "";

    await getMailer().send({
      to: user.email,
      subject: input.title,
      text: `${input.body}${link}`,
    });

    await prisma.notification.update({
      where: { id },
      data: { emailedAt: new Date() },
    });
    increment("notifications_mailed");
  } catch (error) {
    // Deliberately not surfaced to the reader. "We could not email you" is not
    // useful to somebody already looking at the message in the app, and the
    // detail that matters belongs in the log where an operator will find it.
    logger.error("could not mail a notification", error, {
      notificationId: id,
    });
  }
}

/** Keeps the inbox a dropdown rather than a log. */
async function prune(userId: string): Promise<void> {
  const keep = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: NOTIFICATIONS_KEPT,
    select: { id: true },
  });

  if (keep.length < NOTIFICATIONS_KEPT) return;

  await prisma.notification.deleteMany({
    where: { userId, id: { notIn: keep.map((row) => row.id) } },
  });
}

/** One page of somebody's inbox, with the unread count.
 *
 *  The count is a separate query rather than a filter over the page: a badge
 *  that says 3 beside a list of twenty is worse than no badge, and the page is
 *  a page.
 */
export async function listNotifications(userId: string): Promise<{
  items: {
    id: string;
    kind: NotificationKind;
    title: string;
    body: string;
    link: string | null;
    readAt: string | null;
    createdAt: string;
  }[];
  unread: number;
}> {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATIONS_PAGE,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    unread,
  };
}

/** Marks some or all of somebody's notifications read.
 *
 *  Scoped by `userId` in the WHERE clause rather than checked first: the ids
 *  arrive from a client, and a filter that cannot match another person's row
 *  is a stronger thing than a check that has to remember to run. Already-read
 *  rows are excluded so a re-read does not rewrite timestamps.
 */
export async function markRead(
  userId: string,
  ids?: string[],
): Promise<{ read: number }> {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  });

  return { read: result.count };
}
