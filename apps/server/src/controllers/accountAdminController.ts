import type { Request, Response } from "express";
import { z } from "zod";
import { MAX_ACCOUNT_REASON } from "@replit-clone/shared";
import { getAuthContext } from "../middlewares/requireAuth.js";
import {
  getAccountDetail,
  getMachineStatus,
  listRecentAccountActions,
  searchAccounts,
  setAccountOverride,
  setAccountPlan,
} from "../service/accountAdminService.js";

/** The operator's console.
 *
 *  Every write here takes a reason and records itself. That is not politeness:
 *  §6 decision 11 says the moderation authority is small *because* nothing
 *  reviews it, and this is the first power in the product that acts on a
 *  person rather than a project.
 */
const reason = z.string().trim().min(1).max(MAX_ACCOUNT_REASON);

const planSchema = z.object({ planId: z.string().trim().min(1), reason });

/** The override is a partial of the limits, or null to clear. Shapes are
 *  checked again in the service against the schema that READS the column, so
 *  an override that could not be parsed back can never be written. */
const overrideSchema = z.object({
  override: z.record(z.string(), z.union([z.number(), z.boolean()])).nullable(),
  expiresInDays: z.number().int().positive().max(365).optional(),
  reason,
});

export async function searchAccountsController(
  req: Request,
  res: Response,
): Promise<void> {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ success: true, message: "Accounts", data: await searchAccounts(query) });
}

export async function accountDetailController(
  req: Request<{ userId: string }>,
  res: Response,
): Promise<void> {
  res.json({
    success: true,
    message: "Account",
    data: await getAccountDetail(req.params.userId),
  });
}

export async function recentAccountActionsController(
  _req: Request,
  res: Response,
): Promise<void> {
  res.json({
    success: true,
    message: "Account actions",
    data: { actions: await listRecentAccountActions() },
  });
}

export async function setAccountPlanController(
  req: Request<{ userId: string }>,
  res: Response,
): Promise<void> {
  const body = planSchema.parse(req.body ?? {});
  const { email } = getAuthContext(req);

  const action = await setAccountPlan({
    userId: req.params.userId,
    planId: body.planId,
    actor: email,
    reason: body.reason,
  });

  res.json({ success: true, message: "Plan changed", data: { action } });
}

export async function setAccountOverrideController(
  req: Request<{ userId: string }>,
  res: Response,
): Promise<void> {
  const body = overrideSchema.parse(req.body ?? {});
  const { email } = getAuthContext(req);

  const action = await setAccountOverride({
    userId: req.params.userId,
    override: body.override,
    expiresInDays: body.expiresInDays,
    actor: email,
    reason: body.reason,
  });

  res.json({ success: true, message: "Limits changed", data: { action } });
}

export async function machineStatusController(
  _req: Request,
  res: Response,
): Promise<void> {
  res.json({ success: true, message: "Machine", data: await getMachineStatus() });
}
