-- AlterTable
ALTER TABLE "projects" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Backfill from creation time so the column can be made non-null.
UPDATE "projects" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "projects" ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "envVars" JSONB NOT NULL DEFAULT '{}';
