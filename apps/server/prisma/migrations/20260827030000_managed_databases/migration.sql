-- A database this platform runs for a project, in its own container.
--
-- One row per project. The volume name is recorded rather than derived so
-- that deleting a project can remove the volume even if the naming scheme
-- changes later — the lesson deployments learned about published files
-- outliving the row that pointed at them.
CREATE TABLE "managed_databases" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    -- AES-256-GCM under SECRET_ENCRYPTION_KEY. Generated, never chosen, and
    -- never shown: it exists to be injected into the project's container.
    "passwordCipher" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_databases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_databases_projectId_key" ON "managed_databases"("projectId");

ALTER TABLE "managed_databases" ADD CONSTRAINT "managed_databases_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
