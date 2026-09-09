-- The dependency fingerprint a prebuild last completed for. plan.md §12.5.
--
-- The MAPPED table name. plan.md §5 records two migrations that shipped green
-- having never been run because they wrote the model name instead.
ALTER TABLE "projects" ADD COLUMN "prebuiltFingerprint" TEXT;
