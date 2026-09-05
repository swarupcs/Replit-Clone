-- How long a container may sit with nobody attached before it is stopped.
--
-- The idle reaper stops any project container with no attachments after
-- CONTAINER_IDLE_MINUTES and takes the project's database down with it. That
-- is right when the memory is shared: an idle container is somebody else's
-- RAM, and reclaiming it is the platform doing its job.
--
-- It is wrong at n=1, and it is wrong in a way that looks like a bug rather
-- than a policy. The reaper cannot tell "I am finished" from "I closed the
-- lid", so closing a tab kills the dev server, the watch process and the long
-- import behind it, twenty minutes later, with no message. Nobody asked for
-- the memory back.
--
-- So the same argument as the personal plan itself: this is rationing between
-- tenants, and where there is no second tenant it should be settable to never.
-- Zero is that, consistent with UNLIMITED in packages/shared/src/billing.ts.
--
-- What it does NOT mean is that a container lives forever. The machine's own
-- cap is unchanged and no plan can raise it -- decision 15 -- so a host that
-- is out of room still reclaims the least recently used idle container to make
-- space for the one being opened. The plan decides whether IDLENESS is a
-- reason to stop something. The host still decides when it is out of space.
-- Without that second half this column would just turn "your dev server was
-- killed" into "you cannot open a fourth project", which is not an
-- improvement.
--
-- Defaulted to 20, matching CONTAINER_IDLE_MINUTES, so every existing plan
-- keeps exactly the behaviour it had.

ALTER TABLE "plans" ADD COLUMN "idleMinutes" INTEGER NOT NULL DEFAULT 20;

UPDATE "plans" SET "idleMinutes" = 0 WHERE "id" = 'personal';
