-- A workspace and a URL per pull request. plan.md §13.3.
--
-- The MAPPED table names (`@@map`), not the model names. §5 records two
-- migrations that shipped green having never been run because they wrote the
-- model name; nothing but Postgres reads this file.

CREATE TABLE "pull_request_workspaces" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "headRef" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_workspaces_pkey" PRIMARY KEY ("id")
);

-- One workspace per project: a second row pointing at the same workspace would
-- mean the second teardown deletes a project the first already gave away.
CREATE UNIQUE INDEX "pull_request_workspaces_projectId_key"
    ON "pull_request_workspaces"("projectId");

-- One workspace per pull request. This is what makes a redelivered `opened`
-- event a no-op rather than a second container.
CREATE UNIQUE INDEX "pull_request_workspaces_owner_repo_number_key"
    ON "pull_request_workspaces"("owner", "repo", "number");

ALTER TABLE "pull_request_workspaces"
    ADD CONSTRAINT "pull_request_workspaces_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Deliveries already acted on. Unlike the billing equivalent this is a
-- correctness requirement rather than an efficiency one: GitHub's signature
-- carries no timestamp, so a captured delivery stays valid forever and
-- refusing a repeated id is the only replay defence there is.
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");
