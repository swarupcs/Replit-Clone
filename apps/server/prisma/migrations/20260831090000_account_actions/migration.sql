-- What an operator did to an ACCOUNT, as opposed to a project.
--
-- A second audit table rather than a third kind of moderation action. Every
-- row in `moderation_actions` names a project -- `projectName` is copied into
-- it so the record still reads after the project is deleted -- and an action
-- against an account has no project. Fitting one in would mean making that
-- column nullable: loosening a constraint that is doing real work, to hold an
-- event that is not part of the same conversation.
--
-- The console this table exists for GROWS operator authority, which section 6
-- decision 11 says must not happen until something reviews it. This is that
-- something, and it ships in the same commit as the power it records.

CREATE TYPE "AccountActionType" AS ENUM ('PLAN_CHANGED', 'OVERRIDE_SET', 'OVERRIDE_CLEARED');

CREATE TABLE "account_actions" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "subjectEmail" TEXT NOT NULL,
    "action" "AccountActionType" NOT NULL,
    "actor" TEXT NOT NULL,
    -- NOT NULL, unlike a moderation decision's reason. An operator who can
    -- silently change what somebody pays for is a worse position than this
    -- product was in before the console existed.
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_actions_subjectUserId_createdAt_idx" ON "account_actions"("subjectUserId", "createdAt");
CREATE INDEX "account_actions_createdAt_idx" ON "account_actions"("createdAt");

-- SetNull, like the moderation trail: a record that vanishes with its subject
-- can be erased by deleting the subject. `subjectEmail` is copied so the row
-- still says whose account it was.
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "NotificationKind" ADD VALUE 'PLAN_CHANGED';
