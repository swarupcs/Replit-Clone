-- A link that pairs somebody into a project without an account. plan.md §13.6.
--
-- The MAPPED table names (`@@map`), not the model names — §5 records two
-- migrations that shipped green having never run because they wrote the model
-- name, and nothing but Postgres reads this file.
CREATE TABLE "pairing_invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'EDITOR',
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_invites_pkey" PRIMARY KEY ("id")
);

-- The bearer string in the link, and the only thing a guest has.
CREATE UNIQUE INDEX "pairing_invites_token_key" ON "pairing_invites"("token");

CREATE INDEX "pairing_invites_projectId_idx" ON "pairing_invites"("projectId");

-- The sweeper reads this.
CREATE INDEX "pairing_invites_expiresAt_idx" ON "pairing_invites"("expiresAt");

ALTER TABLE "pairing_invites"
    ADD CONSTRAINT "pairing_invites_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pairing_invites"
    ADD CONSTRAINT "pairing_invites_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
