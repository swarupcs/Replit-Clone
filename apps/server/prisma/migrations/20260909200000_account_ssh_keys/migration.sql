-- Public SSH keys an account may open its workspaces with. plan.md §10.1
-- Route C.
--
-- The MAPPED table name (`@@map("user_personalization")`), not the model name.
-- plan.md §5 records two migrations that shipped green having never been run
-- because they wrote the model name; nothing but Postgres reads this file.
ALTER TABLE "user_personalization" ADD COLUMN "sshKeys" JSONB NOT NULL DEFAULT '[]';
