-- A project's build output, published to a public origin.
--
-- One row per project, replaced in place on each deploy. The unique constraint
-- on "subdomain" is what makes the address unambiguous: the public listener
-- resolves a Host header to exactly one row or to nothing at all.

CREATE TYPE "DeploymentStatus" AS ENUM ('BUILDING', 'LIVE', 'FAILED');

CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'BUILDING',
    "buildCommand" TEXT NOT NULL,
    "outputDir" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "deployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deployments_projectId_key" ON "deployments"("projectId");
CREATE UNIQUE INDEX "deployments_subdomain_key" ON "deployments"("subdomain");

-- Deleting a project takes its deployment offline with it. The files on disk
-- are removed by the same service call; this only stops the row outliving the
-- thing it belongs to.
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
