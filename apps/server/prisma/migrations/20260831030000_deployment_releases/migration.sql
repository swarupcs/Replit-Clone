-- Deployment history. A publish used to overwrite its own predecessor, so
-- "put back the one that worked" had nothing to put back.
--
-- liveReleaseId is a POINTER: every build keeps its own directory, and a
-- rollback changes which one is named rather than copying or rebuilding
-- anything. Null means a deployment published before releases existed, whose
-- files are still in the legacy site directory.

ALTER TABLE "deployments" ADD COLUMN "liveReleaseId" TEXT;

CREATE TABLE "deployment_releases" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "kind" "DeploymentKind" NOT NULL,
    "buildCommand" TEXT NOT NULL,
    "outputDir" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_releases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployment_releases_deploymentId_createdAt_idx" ON "deployment_releases"("deploymentId", "createdAt");

ALTER TABLE "deployment_releases" ADD CONSTRAINT "deployment_releases_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
