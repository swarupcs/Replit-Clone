-- Notifications: a stored record first, mail only opportunistically.
--
-- For users only. Moderators are identified by ADMIN_EMAILS rather than by a
-- role column, so one need not have a row in "users" at all; the review queue
-- notifies them by mail instead.

CREATE TYPE "NotificationKind" AS ENUM ('JOB_FAILING', 'JOB_RECOVERED', 'PROJECT_UNPUBLISHED');

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- The unread badge and the list are the same query with and without a filter.
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- Cascade: news addressed to a deleted account is addressed to nobody.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
