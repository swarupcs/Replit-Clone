-- plan.md §13.8: a secret that belongs to the account, not to each project.
--
-- Until now `envVars` existed exactly once in this schema, on "projects". One
-- person with one ANTHROPIC_API_KEY typed it into every workspace they made,
-- and rotating it meant editing each by hand.
--
-- On "user_personalization" rather than in a table of its own, because that
-- table is already the answer to "what follows this person into every
-- container" -- dotfiles and a signing key are there for the same reason this
-- is. It already holds a sealed value, so the precedent for storing one here
-- is set rather than being invented by this column.
--
-- Sealed per value under SECRET_ENCRYPTION_KEY, exactly as "projects"."envVars"
-- is: names in the clear so an operator can see which variables exist, values
-- sealed one at a time so one unreadable value costs one variable and not the
-- whole set.
--
-- Table names here are the MAPPED ones -- "user_personalization", not
-- "UserPersonalization". See the scaffold_recipes migration for what happens
-- when they are not: two migrations shipped green and had never been run.

ALTER TABLE "user_personalization"
    ADD COLUMN "envVars" JSONB NOT NULL DEFAULT '{}';
