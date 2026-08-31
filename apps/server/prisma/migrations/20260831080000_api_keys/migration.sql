-- Long-lived credentials for things that are not people.
--
-- `user_tokens` is single-use, arrives by email and lives an hour. This is the
-- opposite object on every axis, which is why it is not that table with a
-- third purpose: it is presented on every request, for months, from a machine.
--
-- The secret is stored only as a hash. `prefix` is the public half -- it is in
-- the presented string, it is what the lookup keys on, and it is what lets a
-- key be identified in a list without the database holding anything usable.

CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    -- A timestamp, not a delete: "this key was revoked on Tuesday" is the
    -- answer somebody needs after an incident, and a deleted row answers
    -- nothing at all.
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");
CREATE UNIQUE INDEX "api_keys_tokenHash_key" ON "api_keys"("tokenHash");
CREATE INDEX "api_keys_userId_createdAt_idx" ON "api_keys"("userId", "createdAt");

-- Cascade: a credential for an account that no longer exists is not a record
-- worth keeping, unlike the moderation trail, which exists precisely to
-- survive the thing it is about.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
