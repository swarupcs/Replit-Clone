-- Opening a folder that is already on the disk.
--
-- Until now a workspace was a row plus a tree this server created under
-- PROJECTS_ROOT, reachable only by picking a template or importing a
-- repository. There was no path from "I have a directory at ~/code/thing" to
-- "it is open in the editor", which is the only path that matters when the
-- editor is somebody's own.
--
-- Null keeps the original arrangement, which is every row that exists today:
-- the tree is PROJECTS_ROOT/<id> and this server owns it outright. Set, the
-- tree was already there and this platform is a visitor in it -- so the four
-- operations that assume ownership (recursive delete, chown to the sandbox
-- uid, the disk quota, and copy-on-fork) each ask first.
--
-- Unique because two rows pointing at one directory is two containers writing
-- one tree with no arbiter, and nothing downstream is built for that. Opening
-- an already-open folder finds the existing project instead.
--
-- A partial index, matching `deletedAt`'s: almost every row is null here, so
-- the index worth having is the one over the few that are not.

ALTER TABLE "projects" ADD COLUMN "localPath" TEXT;

CREATE UNIQUE INDEX "projects_localPath_key" ON "projects" ("localPath")
  WHERE "localPath" IS NOT NULL;
