-- A delete that can be undone.
--
-- Everything a user has lives in exactly one place, and the path that removes
-- it is thorough, correct and irreversible with a dialog in front of it. This
-- does not answer "the host died" -- that needs a destination and is still
-- open -- it answers "I meant the other project", which is the one that
-- actually happens.
--
-- Partial index rather than a plain one: every list and every resolve asks for
-- deletedAt IS NULL, which is almost every row, so the index that helps is the
-- one over the few rows in the trash.

ALTER TABLE "projects" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "projects_deletedAt_idx" ON "projects" ("deletedAt")
  WHERE "deletedAt" IS NOT NULL;
