-- Whether a stranger with an embed link may edit and run it. plan.md §13.1.
--
-- The MAPPED table name (`@@map("embeds")`), not the model name. plan.md §5
-- records two migrations that shipped green having never been run because they
-- wrote the model name; nothing but Postgres reads this file.
--
-- Default false: an embed is something to read, and turning every published one
-- into an editable sandbox because a column appeared would change what somebody
-- already shared.
ALTER TABLE "embeds" ADD COLUMN "sandbox" BOOLEAN NOT NULL DEFAULT false;
