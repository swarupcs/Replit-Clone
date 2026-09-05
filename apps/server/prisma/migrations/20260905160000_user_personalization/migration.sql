-- plan.md §11.9: an identity that follows you into the container.
--
-- A table rather than columns on "users", and "signingKey" is the whole
-- argument: a column on "users" is returned by every findUnique that forgets
-- a select, and a private key is not a thing to leave lying in the default
-- shape of the account row. A separate table cannot be loaded by accident.
--
-- Table names here are the MAPPED ones -- "users", not "User". See the
-- scaffold_recipes migration for what happens when they are not.

CREATE TABLE "user_personalization" (
    "userId" TEXT NOT NULL,

    -- Dotfiles: the same three fields the devcontainer ecosystem settled on.
    "dotfilesRepo" TEXT,
    "dotfilesTarget" TEXT,
    "dotfilesInstall" TEXT,

    -- Sealed with the same box the push tokens use. Never returned by the API.
    "signingKey" TEXT,
    -- The public half, in the clear, because it is meant to be pasted into
    -- GitHub and there is no reason to make the server derive it each time.
    "signingKeyPublic" TEXT,
    -- Separate from the key existing, so adding a key does not silently change
    -- what every future commit is.
    "signCommits" BOOLEAN NOT NULL DEFAULT false,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_personalization_pkey" PRIMARY KEY ("userId")
);

-- Cascade: this row is worth nothing without the account it personalises, and
-- leaving a sealed private key behind after the account is gone would be the
-- one row in this database that must not outlive its owner.
ALTER TABLE "user_personalization"
    ADD CONSTRAINT "user_personalization_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
