-- plan.md §12.1: a workspace that is not the same size as every other workspace.
--
-- Both nullable, and null means "the deployment's default" rather than a
-- number. That keeps CONTAINER_MEMORY_MB / CONTAINER_CPUS the one place to
-- change every unconfigured workspace at once, and it means this migration
-- changes the behaviour of exactly nothing until somebody sets a size.
ALTER TABLE "Project" ADD COLUMN "memoryMb" INTEGER;
ALTER TABLE "Project" ADD COLUMN "cpus" DOUBLE PRECISION;
