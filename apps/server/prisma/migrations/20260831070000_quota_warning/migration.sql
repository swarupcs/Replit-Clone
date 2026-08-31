-- Telling somebody they are nearly out of room, before they are out of it.
--
-- One bit per account, not a count and not a timestamp per quota: the warning
-- is about a CHANGE of state, so what has to be remembered is whether the
-- account is already in that state. Cleared when it drops back under the line.
--
-- Here rather than derived from the notifications table, which is pruned at
-- 200 rows per user -- deriving it would eventually have the pruner decide to
-- warn somebody all over again about a quota they have been near for a month.

ALTER TYPE "NotificationKind" ADD VALUE 'QUOTA_WARNING';

ALTER TABLE "users" ADD COLUMN "quotaWarnedAt" TIMESTAMP(3);
