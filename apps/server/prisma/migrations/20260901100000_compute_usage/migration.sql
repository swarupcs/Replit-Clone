-- A meter for the thing this platform actually spends.
--
-- Disk and project count are limited and measured; container-hours are the
-- real cost and were measured nowhere. plan.md 8.8 asks whether this product
-- sells capability or sells minutes, and that question cannot be answered
-- without usage data -- so the meter comes first and the pricing decision
-- waits for it.
--
-- One row per account per day, written by a sweep rather than by a session
-- with an end that a restart can eat. See plan.md 9.3.

CREATE TABLE "compute_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "compute_usage_pkey" PRIMARY KEY ("id")
);

-- The upsert the sweep does every minute depends on this.
CREATE UNIQUE INDEX "compute_usage_userId_day_key" ON "compute_usage" ("userId", "day");
CREATE INDEX "compute_usage_day_idx" ON "compute_usage" ("day");

ALTER TABLE "compute_usage" ADD CONSTRAINT "compute_usage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
