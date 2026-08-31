import type { Request, Response } from "express";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { getAccountSummary } from "../service/accountService.js";

/** The account's own usage, limits and plan.
 *
 *  Scoped by the auth context and by nothing else: there is no id in the path
 *  and none in the query, which is the only scoping nobody can forget.
 */
export async function accountSummaryController(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = getAuthContext(req);
  res.json({ data: await getAccountSummary(userId) });
}
