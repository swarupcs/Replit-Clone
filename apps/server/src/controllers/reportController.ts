import type { Request, Response } from "express";
import { z } from "zod";
import { getAuthContext } from "../middlewares/requireAuth.js";
import { assertValidProjectId } from "../utils/projectPaths.js";
import {
  fileReport,
  listReports,
  MAX_DETAILS,
  reviewReport,
} from "../service/reportService.js";

const reportSchema = z.object({
  reason: z.enum(["SECRETS", "ABUSE", "MALWARE", "INFRINGEMENT", "OTHER"]),
  details: z.string().trim().max(MAX_DETAILS).optional(),
});

/** Which slice of the queue to show.
 *
 *  Defaults to OPEN, because the queue is a worklist and everything else on it
 *  is history. `ALL` exists so a project reported and cleared repeatedly can
 *  be seen for what it is. */
const queueSchema = z.object({
  status: z.enum(["OPEN", "DISMISSED", "ACTIONED", "ALL"]).default("OPEN"),
});

const reviewSchema = z.object({
  decision: z.enum(["DISMISSED", "ACTIONED"]),
});

export async function reportProjectController(
  req: Request<{ projectId: string }>,
  res: Response,
): Promise<void> {
  const projectId = assertValidProjectId(req.params.projectId);
  const { userId } = getAuthContext(req);
  const body = reportSchema.parse(req.body);

  const report = await fileReport({
    projectId,
    reporterId: userId,
    reason: body.reason,
    details: body.details,
  });

  res.status(201).json({
    success: true,
    message:
      "Reported. An operator will look at it; you will not hear back " +
      "individually.",
    data: { id: report.id },
  });
}

export async function listReportsController(
  req: Request,
  res: Response,
): Promise<void> {
  const { status } = queueSchema.parse(req.query);

  res.json({
    success: true,
    message: "Reports",
    // `{ items, nextCursor }`, the one page shape every list here answers
    // with. The queue used to take two hundred rows and say nothing about the
    // two hundred and first.
    data: await listReports(status, undefined, req.query),
  });
}

export async function reviewReportController(
  req: Request<{ reportId: string }>,
  res: Response,
): Promise<void> {
  const { email } = getAuthContext(req);
  const { decision } = reviewSchema.parse(req.body);

  // Not `assertValidProjectId` -- that one also claims the id as a directory
  // name. A report id is only ever a database key.
  const reportId = z.string().uuid().parse(req.params.reportId);

  const report = await reviewReport({ reportId, decision, reviewerEmail: email });

  res.json({
    success: true,
    message:
      decision === "ACTIONED"
        ? "Project made private."
        : "Report dismissed.",
    data: { report },
  });
}
