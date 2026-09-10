-- Which repositories may have pull-request workspaces here. plan.md §13.3.
--
-- The MAPPED table names (`@@map`), not the model names — §5 records two
-- migrations that shipped green having never run because they wrote the model
-- name, and nothing but Postgres reads this file.
--
-- Enrolment is explicit, and that is the security decision in the row. The
-- alternative was to match a delivery against `github_connections.login` and
-- build any repository a connected user happens to own, which silently enrols
-- every repository of every connected account.
CREATE TABLE "pull_request_repos" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_request_repos_pkey" PRIMARY KEY ("id")
);

-- One enrolment per repository: two accounts cannot both claim it, which keeps
-- "whose quota does this spend" a question with one answer.
CREATE UNIQUE INDEX "pull_request_repos_owner_repo_key"
    ON "pull_request_repos"("owner", "repo");

CREATE INDEX "pull_request_repos_userId_idx" ON "pull_request_repos"("userId");

ALTER TABLE "pull_request_repos"
    ADD CONSTRAINT "pull_request_repos_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
