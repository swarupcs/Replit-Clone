-- What `Run` executes, when the template's default is not right.
--
-- Null means "use the template's", which is every project that existed before
-- this column did.
ALTER TABLE "projects" ADD COLUMN "startCommand" TEXT;
