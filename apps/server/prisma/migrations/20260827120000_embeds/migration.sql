-- A read-only, unauthenticated view of a project, for framing in someone
-- else's page. One row per project: the token IS the embed, so replacing it is
-- an update rather than a second row.
CREATE TABLE "embeds" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "view" TEXT NOT NULL DEFAULT 'split',
    "preview" TEXT NOT NULL DEFAULT 'deployment',
    "activeFile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "embeds_projectId_key" ON "embeds"("projectId");

-- The lookup every anonymous request makes, and the reason a guessed token
-- costs one indexed miss rather than a scan.
CREATE UNIQUE INDEX "embeds_token_key" ON "embeds"("token");

ALTER TABLE "embeds" ADD CONSTRAINT "embeds_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
