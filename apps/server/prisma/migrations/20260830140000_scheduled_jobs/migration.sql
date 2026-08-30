-- Cron jobs for a project, and the history of what they did.

CREATE TYPE "ScheduledRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT', 'ERRORED');

CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Five cron fields, UTC. Stored as written: it is shown back to the owner,
    -- and a round trip through the parser would return something correct that
    -- they did not type.
    "schedule" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    -- Null when disabled, and null when the expression parses but matches no
    -- reachable instant -- `0 0 30 2 *` is valid cron and will never happen.
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_runs" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "ScheduledRunStatus" NOT NULL DEFAULT 'RUNNING',
    "exitCode" INTEGER,
    "output" TEXT,

    CONSTRAINT "scheduled_runs_pkey" PRIMARY KEY ("id")
);

-- The sweeper's whole query: enabled jobs that are due.
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");
CREATE INDEX "scheduled_jobs_projectId_idx" ON "scheduled_jobs"("projectId");
CREATE INDEX "scheduled_runs_jobId_startedAt_idx" ON "scheduled_runs"("jobId", "startedAt");

ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
