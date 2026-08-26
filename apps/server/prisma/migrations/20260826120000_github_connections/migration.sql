-- A GitHub authorisation the server may act under.
--
-- The token is stored encrypted, never in plaintext: unlike a password it
-- cannot be hashed, because the point is to spend it later.
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenCipher" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- One connection per user: a second would be ambiguous about which token to
-- spend.
CREATE UNIQUE INDEX "github_connections_userId_key" ON "github_connections"("userId");

-- Deleting the account takes the authorisation with it.
ALTER TABLE "github_connections"
    ADD CONSTRAINT "github_connections_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
