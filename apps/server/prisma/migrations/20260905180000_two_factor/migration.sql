-- plan.md §11.6: a second factor, for an editor that can be reached from the
-- open internet.
--
-- Its own table rather than columns on "users", and the TOTP secret is the
-- argument: it is password-equivalent, and `authenticateUser` does a bare
-- findUnique on the user row with no select at all. A separate table cannot be
-- loaded by accident.
--
-- Table names here are the MAPPED ones -- "users", not "User". See the
-- scaffold_recipes migration for what happens when they are not.

CREATE TABLE "user_two_factor" (
    "userId" TEXT NOT NULL,

    -- Sealed with the same box the push tokens and the signing key use.
    "secret" TEXT NOT NULL,

    -- Null until the first correct code proved the app really has the secret.
    -- A row in that state is NOT protection: treating it as such would lock an
    -- account behind a secret nobody finished writing down.
    "confirmedAt" TIMESTAMP(3),

    -- SHA-256 of each UNUSED recovery code. Hashed rather than sealed: they
    -- are only ever compared. Empty array rather than null, so "none left" and
    -- "never generated" are the same shape and neither needs a null check.
    "recoveryCodeHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- The last TOTP counter accepted. A code is valid for a whole window, so
    -- without this one read over a shoulder works again for thirty seconds.
    "lastUsedStep" BIGINT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_two_factor_pkey" PRIMARY KEY ("userId")
);

-- Cascade: a second factor for a deleted account protects nothing and is a
-- password-equivalent secret left lying about.
ALTER TABLE "user_two_factor"
    ADD CONSTRAINT "user_two_factor_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
