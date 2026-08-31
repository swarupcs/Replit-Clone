import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { listNotifications, markRead } from "../service/notificationService.js";

/** Which notifications to mark read.
 *
 *  An absent list means all of them, which is what the "mark all read" button
 *  sends. An explicit list is scoped to the caller in the query itself rather
 *  than checked here — see `markRead`.
 */
const readSchema = z.object({
  ids: z.array(z.string().uuid()).max(200).optional(),
});

export async function listNotificationsController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  res.json({ data: await listNotifications(userId) });
}

export async function markNotificationsReadController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  const body = readSchema.parse(req.body ?? {});

  const result = await markRead(userId, body.ids);

  // The list comes back with the response rather than being re-fetched by the
  // client. The badge and the list have to agree, and two round trips is how
  // they come to disagree.
  res.json({ data: { ...(await listNotifications(userId)), read: result.read } });
}
