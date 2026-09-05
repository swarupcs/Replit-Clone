-- Whether a project's dev server serves under the preview proxy's prefix,
-- overriding its template's answer. Null means "ask the template".
--
-- "projects", not "Project": the model carries @@map("projects"), and two
-- migrations in this tree shipped naming the model instead. See plan.md 2.41.
ALTER TABLE "projects" ADD COLUMN "expectsPreviewBase" BOOLEAN;
