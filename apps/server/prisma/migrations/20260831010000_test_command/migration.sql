-- What the test panel runs, when the template's default is not right.
-- Null means "use the template's", like startCommand beside it.
ALTER TABLE "projects" ADD COLUMN "testCommand" TEXT;
