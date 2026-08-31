-- The moderation trail: who acted, when, and why -- plus the owner's appeal,
-- in the same table because it is one conversation and only reads in order.

CREATE TYPE "ModerationActionType" AS ENUM ('ACTIONED', 'DISMISSED', 'APPEALED', 'REINSTATED');

CREATE TABLE "moderation_actions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "projectName" TEXT NOT NULL,
    "reportId" TEXT,
    "action" "ModerationActionType" NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "moderation_actions_projectId_createdAt_idx" ON "moderation_actions"("projectId", "createdAt");

-- SetNull, not Cascade: a trail that vanishes with its subject can be erased
-- by deleting the subject. projectName is copied so the record still names it.
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
