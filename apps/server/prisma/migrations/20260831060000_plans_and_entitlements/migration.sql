-- Plans, and the per-account overrides that go on top of them.
--
-- Every limit in this product was a constant in `env`, which is the right
-- shape for a deployment and the wrong one for a product: a SaaS product is
-- precisely one where these numbers differ per customer.
--
-- The seeded `free` plan carries exactly the `env` defaults, so introducing
-- this changes nothing for anybody. That is the point: the limits arrive by a
-- different route and hold the same values, which is a claim the existing
-- suite can check.

CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "rank" INTEGER NOT NULL DEFAULT 0,
    "maxProjects" INTEGER NOT NULL,
    "userDiskQuotaMb" INTEGER NOT NULL,
    "projectDiskQuotaMb" INTEGER NOT NULL,
    "aiRequestsPerHour" INTEGER NOT NULL,
    "maxContainersPerUser" INTEGER NOT NULL,
    "managedDatabases" BOOLEAN NOT NULL DEFAULT false,
    "customDomains" BOOLEAN NOT NULL DEFAULT false,
    "scheduledJobs" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- Seeded here rather than by a script, because `users.planId` defaults to
-- 'free' and a foreign key to a row that does not exist would make the next
-- signup the thing that discovers it.
--
-- The numbers are the `env` defaults as of this migration: 20 projects,
-- 2048 MB across them, 512 MB each, 60 assistant requests an hour, 2 running
-- containers. Every feature flag is on, because they are on today and taking
-- something away from existing accounts is not what this migration is for.
-- What a free tier should actually include is a pricing decision, and it is
-- one row of UPDATE once somebody makes it.
INSERT INTO "plans" ("id", "label", "priceCents", "currency", "rank", "maxProjects", "userDiskQuotaMb", "projectDiskQuotaMb", "aiRequestsPerHour", "maxContainersPerUser", "managedDatabases", "customDomains", "scheduledJobs")
VALUES ('free', 'Free', 0, 'usd', 0, 20, 2048, 512, 60, 2, true, true, true);

ALTER TABLE "users" ADD COLUMN "planId" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "users" ADD COLUMN "entitlementOverride" JSONB;
ALTER TABLE "users" ADD COLUMN "overrideReason" TEXT;
ALTER TABLE "users" ADD COLUMN "overrideUntil" TIMESTAMP(3);

-- RESTRICT: deleting a plan out from under the accounts on it is the one
-- operation this table must refuse. Archive it instead -- `archivedAt` takes
-- it out of the catalogue while everyone on it keeps every number they had.
ALTER TABLE "users" ADD CONSTRAINT "users_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every read of this column is "which accounts are on this plan", which is the
-- operator's question and the one a pricing change has to answer.
CREATE INDEX "users_planId_idx" ON "users"("planId");
