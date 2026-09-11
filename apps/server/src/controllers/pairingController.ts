import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertProjectAccess } from "../service/projectAccessService.js";
import {
  assertRole,
  createPairingInvite,
  listPairingInvites,
  redeemPairingInvite,
  revokePairingInvite,
} from "../service/pairingService.js";

/** Pairing links. plan.md §13.6. */

export const createInviteSchema = z.object({
  role: z.enum(["VIEWER", "EDITOR"]).optional(),
  label: z.string().max(100).optional(),
});

export const redeemSchema = z.object({
  token: z.string().min(1).max(512),
  /** What the guest would like to be called. Bounded here and cleaned again in
   *  the service, because it ends up beside somebody's cursor. */
  name: z.string().max(80).optional(),
});

/** Only the owner may open a door into their own project.
 *
 *  `assertProjectAccess` with "owner": an EDITOR collaborator inviting
 *  anonymous guests would be a collaborator handing out the owner's compute,
 *  which is a decision the owner has not made.
 */
export async function createPairingInviteController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const projectId = String(req.params["projectId"] ?? "");
  const body = createInviteSchema.parse(req.body);

  await assertProjectAccess(projectId, userId, "owner");

  const invite = await createPairingInvite(projectId, userId, {
    role: assertRole(body.role),
    ...(body.label === undefined ? {} : { label: body.label }),
  });

  res.status(201).json({ success: true, message: "Pairing link created", data: invite });
}

export async function listPairingInvitesController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const projectId = String(req.params["projectId"] ?? "");

  await assertProjectAccess(projectId, userId, "owner");

  res.json({
    success: true,
    message: "Pairing links",
    data: await listPairingInvites(projectId),
  });
}

export async function revokePairingInviteController(req: Request, res: Response) {
  const { userId } = getAuthContext(req);
  const projectId = String(req.params["projectId"] ?? "");
  const inviteId = String(req.params["inviteId"] ?? "");

  await assertProjectAccess(projectId, userId, "owner");
  await revokePairingInvite(projectId, inviteId);

  res.json({ success: true, message: "Pairing link revoked", data: null });
}

/** Redeeming, which is the whole point: NO `requireAuth` in front of it.
 *
 *  The person on the other end has no account and this is the endpoint that
 *  lets them in without making one. What they get back is a pairing token —
 *  typed, scoped to this one project, and expiring — rather than a session.
 */
export async function redeemPairingController(req: Request, res: Response) {
  const body = redeemSchema.parse(req.body);

  const redeemed = await redeemPairingInvite(body.token, body.name);

  res.json({ success: true, message: "Paired", data: redeemed });
}
