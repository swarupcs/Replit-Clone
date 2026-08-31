-- Reporting a public project, and the queue an operator works through.

CREATE TYPE "ProjectReportReason" AS ENUM ('SECRETS', 'ABUSE', 'MALWARE', 'INFRINGEMENT', 'OTHER');
CREATE TYPE "ProjectReportStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

CREATE TABLE "project_reports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    -- Nullable: a report outlives the account that filed it, so deleting an
    -- account does not withdraw a complaint nobody has acted on yet.
    "reporterId" TEXT,
    "reason" "ProjectReportReason" NOT NULL,
    "details" TEXT,
    "status" "ProjectReportStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_reports_pkey" PRIMARY KEY ("id")
);

-- One report per person per project: without it a single account can file the
-- same complaint a thousand times and bury every other report in the queue.
CREATE UNIQUE INDEX "project_reports_projectId_reporterId_key" ON "project_reports"("projectId", "reporterId");
CREATE INDEX "project_reports_status_createdAt_idx" ON "project_reports"("status", "createdAt");

ALTER TABLE "project_reports" ADD CONSTRAINT "project_reports_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_reports" ADD CONSTRAINT "project_reports_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
