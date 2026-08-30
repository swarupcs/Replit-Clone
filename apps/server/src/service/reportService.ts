import { prisma } from "../lib/prisma.js";
import { BadRequestError, ConflictError, NotFoundError } from "../utils/errors.js";
import { increment } from "../lib/metrics.js";
import { logger } from "../lib/logger.js";
import type {
  ProjectReportReason,
  ProjectReportStatus,
} from "../generated/prisma/enums.js";

/** Reporting a public project, and the queue an operator works through.
 *
 *  The half of §3.1 that needed a decision about authority. `requireAdmin`
 *  holds that decision; this file assumes only that somebody has it.
 */

/** How much a reporter may write. Enforced here as well as in the request
 *  schema, because this is the boundary the database is behind. */
export const MAX_DETAILS = 2000;

export interface ReportSummary {
  id: string;
  projectId: string;
  projectName: string;
  ownerEmail: string;
  reason: ProjectReportReason;
  details: string | null;
  status: ProjectReportStatus;
  /** Null when the account that filed it has since been deleted. */
  reporterEmail: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

/** Prisma's unique-constraint failure, recognised without importing its error
 *  class.
 *
 *  The generated client is regenerated into `src/generated`, and narrowing on
 *  a shape rather than an `instanceof` keeps this working across that boundary
 *  and across the client being swapped for a mock in tests.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/** Files a report against a public project.
 *
 *  Refuses in three cases, each for its own reason rather than for tidiness:
 *  a project that is not public has no audience to protect; a project you own
 *  is one you can make private yourself; and a second report from the same
 *  account is the same complaint again, which would bury everybody else's.
 */
export async function fileReport(input: {
  projectId: string;
  reporterId: string;
  reason: ProjectReportReason;
  details?: string | undefined;
}): Promise<{ id: string }> {
  const details = input.details?.trim();
  if (details && details.length > MAX_DETAILS) {
    throw new BadRequestError(
      `Keep the description under ${String(MAX_DETAILS)} characters.`,
      "DETAILS_TOO_LONG",
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, ownerId: true, visibility: true },
  });

  // Not found and not public are answered identically on purpose. Otherwise
  // this endpoint tells anybody with an id whether a private project exists,
  // which is exactly what PRIVATE is for.
  if (!project || project.visibility !== "PUBLIC") {
    throw new NotFoundError("No public project with that id.", "NOT_PUBLIC");
  }

  if (project.ownerId === input.reporterId) {
    throw new BadRequestError(
      "This is your project. Make it private instead — that is never rate " +
        "limited.",
      "OWN_PROJECT",
    );
  }

  const existing = await prisma.projectReport.findUnique({
    where: {
      projectId_reporterId: {
        projectId: input.projectId,
        reporterId: input.reporterId,
      },
    },
    select: { id: true },
  });

  if (existing) {
    throw new ConflictError(
      "You have already reported this project. It is in the queue.",
      "ALREADY_REPORTED",
    );
  }

  let report: { id: string };
  try {
    report = await prisma.projectReport.create({
      data: {
        projectId: input.projectId,
        reporterId: input.reporterId,
        reason: input.reason,
        details: details && details.length > 0 ? details : null,
      },
      select: { id: true },
    });
  } catch (error) {
    // The check above and this catch answer the same question, and both are
    // needed. The check gives the common case a clean 409 without a failed
    // write; the index is what is actually true under a race, because two
    // requests can both read "no existing report" before either writes one.
    // Without this, the loser of that race gets a 500 for having done nothing
    // wrong -- and the queue's one real guarantee would be a promise the API
    // breaks by crashing rather than by admitting.
    if (!isUniqueViolation(error)) throw error;

    throw new ConflictError(
      "You have already reported this project. It is in the queue.",
      "ALREADY_REPORTED",
    );
  }

  increment("project_reported");
  // Logged at info, because on a deployment with nobody watching the queue this
  // line is the only thing that says a report happened at all.
  logger.info("project reported", {
    projectId: input.projectId,
    reason: input.reason,
  });

  return report;
}

/** The queue, newest first. */
export async function listReports(
  status: ProjectReportStatus | "ALL" = "OPEN",
): Promise<ReportSummary[]> {
  const rows = await prisma.projectReport.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      project: { select: { name: true, owner: { select: { email: true } } } },
      reporter: { select: { email: true } },
    },
  });

  return rows.map(toSummary);
}

/** A row as the queue reads it. One mapping, so a field added to the list and
 *  missing from the single read cannot happen. */
function toSummary(row: {
  id: string;
  projectId: string;
  project: { name: string; owner: { email: string } };
  reason: ProjectReportReason;
  details: string | null;
  status: ProjectReportStatus;
  reporter: { email: string } | null;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}): ReportSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project.name,
    ownerEmail: row.project.owner.email,
    reason: row.reason,
    details: row.details,
    status: row.status,
    reporterEmail: row.reporter?.email ?? null,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy ?? null,
  };
}

/** Reviews one report.
 *
 *  `ACTIONED` makes the project private, which is the only authority this
 *  grants: an operator can take something out of the gallery. They cannot
 *  delete it, cannot edit it, and cannot touch the owner's account. That is
 *  deliberate — the smallest power that resolves the complaint, and the one
 *  whose mistakes are undoable by the person they were made against.
 */
export async function reviewReport(input: {
  reportId: string;
  decision: "DISMISSED" | "ACTIONED";
  reviewerEmail: string;
}): Promise<ReportSummary> {
  const report = await prisma.projectReport.findUnique({
    where: { id: input.reportId },
    select: { id: true, projectId: true, status: true },
  });

  if (!report) throw new NotFoundError("No such report.", "REPORT_NOT_FOUND");

  if (report.status !== "OPEN") {
    throw new ConflictError(
      "That report has already been reviewed.",
      "ALREADY_REVIEWED",
    );
  }

  const reviewedAt = new Date();

  await prisma.$transaction(async (tx) => {
    if (input.decision === "ACTIONED") {
      await tx.project.update({
        where: { id: report.projectId },
        data: { visibility: "PRIVATE" },
      });

      // Everybody else who reported this project reported the thing that has
      // just been dealt with. Left open, a project reported by nine people
      // would sit in the queue eight more times after it was already private,
      // and an operator working through it would be deciding the same case
      // repeatedly with no way to tell it was the same case.
      await tx.projectReport.updateMany({
        where: { projectId: report.projectId, status: "OPEN" },
        data: {
          status: "ACTIONED",
          reviewedAt,
          reviewedBy: input.reviewerEmail,
        },
      });

      return;
    }

    // A dismissal speaks only for the report it was made about. Two people can
    // object to a project for different reasons, and finding one of them
    // baseless says nothing about the other.
    await tx.projectReport.update({
      where: { id: report.id },
      data: {
        status: input.decision,
        reviewedAt,
        reviewedBy: input.reviewerEmail,
      },
    });
  });

  increment(
    input.decision === "ACTIONED" ? "report_actioned" : "report_dismissed",
  );
  logger.info("report reviewed", {
    reportId: report.id,
    projectId: report.projectId,
    decision: input.decision,
    reviewer: input.reviewerEmail,
  });

  const updated = await findReport(report.id);
  if (!updated) throw new NotFoundError("No such report.", "REPORT_NOT_FOUND");

  return updated;
}

/** One report, in the shape the queue uses. */
export async function findReport(id: string): Promise<ReportSummary | null> {
  const row = await prisma.projectReport.findUnique({
    where: { id },
    include: {
      project: { select: { name: true, owner: { select: { email: true } } } },
      reporter: { select: { email: true } },
    },
  });

  return row ? toSummary(row) : null;
}
