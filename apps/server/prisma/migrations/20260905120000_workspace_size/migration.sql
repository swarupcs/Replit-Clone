-- plan.md §12.1: a workspace that is not the same size as every other workspace.
--
-- "projects", not "Project". The model carries @@map("projects"), so the
-- model name is not a relation Postgres has ever heard of. This shipped
-- naming the model and failed on the first `migrate deploy` with
-- `relation "Project" does not exist` -- three weeks of green typecheck,
-- lint and tests in between, because not one of them reads this file.
--
-- Both nullable, and null means "the deployment's default" rather than a
-- number. That keeps CONTAINER_MEMORY_MB / CONTAINER_CPUS the one place to
-- change every unconfigured workspace at once, and it means this migration
-- changes the behaviour of exactly nothing until somebody sets a size.
ALTER TABLE "projects" ADD COLUMN "memoryMb" INTEGER;
ALTER TABLE "projects" ADD COLUMN "cpus" DOUBLE PRECISION;
