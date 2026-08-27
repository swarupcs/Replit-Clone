-- An external database a project's query editor is pointed at.
--
-- One row per project: the editor addresses "this project's database" rather
-- than a URL, so the connection string never travels to the client and the
-- client can never name a host of its own choosing.
CREATE TABLE "project_database_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    -- AES-256-GCM under SECRET_ENCRYPTION_KEY, never the plaintext. The
    -- string carries a password that has to be spendable later, so a leaked
    -- dump must hand over ciphertext and nothing more.
    "urlCipher" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    -- Host and port for display, so the panel can name the database without
    -- decrypting anything. Credentials are deliberately absent.
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_database_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_database_connections_projectId_key"
    ON "project_database_connections"("projectId");

-- Deleting a project takes its stored connection with it. A sealed credential
-- outliving the thing it belonged to is the mistake deployments already
-- learned once.
ALTER TABLE "project_database_connections" ADD CONSTRAINT "project_database_connections_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
