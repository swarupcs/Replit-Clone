-- Several checkouts of one repository that know they are related. plan.md §13.4.
--
-- The MAPPED table names (`@@map`), not the model names — §5 records two
-- migrations that shipped green having never run because they wrote the model
-- name, and nothing but Postgres reads this file.
CREATE TABLE "workspace_groups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "envVars" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_groups_pkey" PRIMARY KEY ("id")
);

-- One group per repository per account: the group IS the repository's identity
-- on this account, so a second row for it would be a second identity.
CREATE UNIQUE INDEX "workspace_groups_userId_owner_repo_key"
    ON "workspace_groups"("userId", "owner", "repo");

ALTER TABLE "workspace_groups"
    ADD CONSTRAINT "workspace_groups_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable: the ordinary project is nobody's second checkout.
ALTER TABLE "projects" ADD COLUMN "groupId" TEXT;

CREATE INDEX "projects_groupId_idx" ON "projects"("groupId");

-- SET NULL and not CASCADE, deliberately: dissolving a group must not delete
-- the work inside it. That is the difference between grouping and owning.
ALTER TABLE "projects"
    ADD CONSTRAINT "projects_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "workspace_groups"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
