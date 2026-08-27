-- Idempotent on purpose: this runs on every start, not just the first.
-- A migration that only works against an empty database is a migration that
-- breaks the second time the container comes up.
CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notes (body)
SELECT 'This row came from schema.sql, through a real database.'
WHERE NOT EXISTS (SELECT 1 FROM notes);
