import type { Request, Response } from "express";
import { aiStatus } from "../service/aiService.js";

/** Whether this deployment has an assistant at all.
 *
 *  The same shape as the sign-in providers endpoint, and for the same reason:
 *  the web app asks once and hides the panel entirely rather than offering a
 *  feature that answers every question with a configuration error.
 */
export function aiStatusController(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, message: "Assistant", data: aiStatus() });

  return Promise.resolve();
}
