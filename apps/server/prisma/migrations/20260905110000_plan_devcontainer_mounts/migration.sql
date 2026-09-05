-- Whether a project's devcontainer.json may ask for extra host mounts.
--
-- devcontainer.ts refuses "mounts" outright today, with the reason "the
-- project directory is the only thing mounted, deliberately". That is a
-- confinement rule about OTHER PEOPLE's directories, and it is right for a
-- sandbox running a stranger's code. On your own machine your own ~/.aws is
-- not somebody else's directory, and refusing it is the multi-tenant posture
-- outliving the tenancy -- the same argument the personal plan already makes
-- about quotas and about idleMinutes.
--
-- Two gates, and the second one is the important one. This column says whether
-- an account may ASK. DEVCONTAINER_MOUNT_ROOTS says what there is to ask for,
-- and is empty by default, where empty means refuse everything.
--
-- Both, because unlike every other limit on this table the request does not
-- come from the user. It comes from a file inside the repository, which may
-- have been cloned from a stranger five minutes ago -- so a single gate here
-- would mean that opening somebody else's project mounted whatever that
-- project asked for. /var/run/docker.sock is a path like any other, and a
-- container that can reach it owns the host.
--
-- Defaulted false so every existing plan keeps refusing, and true only for
-- personal -- where the operator and the user are the same person, and the
-- roots they name are already theirs.

ALTER TABLE "plans" ADD COLUMN "devcontainerMounts" BOOLEAN NOT NULL DEFAULT false;

UPDATE "plans" SET "devcontainerMounts" = true WHERE "id" = 'personal';
