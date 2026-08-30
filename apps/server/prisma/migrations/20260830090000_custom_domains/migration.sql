-- A hostname the owner controls, pointed at a deployment.

ALTER TABLE "deployments" ADD COLUMN "customDomain" TEXT;
ALTER TABLE "deployments" ADD COLUMN "domainToken" TEXT;
ALTER TABLE "deployments" ADD COLUMN "domainVerifiedAt" TIMESTAMP(3);
ALTER TABLE "deployments" ADD COLUMN "domainCheckedAt" TIMESTAMP(3);

-- An address, so two sites cannot answer at one. The database is the only
-- place this can be settled: two owners can both pass a "is it taken" check
-- before either writes, and the loser of that race must be refused rather
-- than quietly take over somebody else's name.
CREATE UNIQUE INDEX "deployments_customDomain_key" ON "deployments"("customDomain");

-- The re-check sweep reads by this column and by nothing else.
CREATE INDEX "deployments_domainCheckedAt_idx" ON "deployments"("domainCheckedAt");
