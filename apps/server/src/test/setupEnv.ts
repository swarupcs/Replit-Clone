import os from "node:os";
import path from "node:path";

/** Minimum viable environment for `config/env.ts`.
 *
 *  It parses `process.env` at import time and exits the process when the schema
 *  fails, so this has to run before any module that reaches it. Values are
 *  deliberately throwaway — nothing here talks to Postgres or Docker.
 */
process.env["DATABASE_URL"] ??= "postgresql://test:test@127.0.0.1:5432/test";
process.env["JWT_ACCESS_SECRET"] ??= "a".repeat(48);
process.env["JWT_REFRESH_SECRET"] ??= "b".repeat(48);
process.env["NODE_ENV"] = "test";
// A throwaway 32-byte key, so anything that stores a secret is exercised
// rather than skipped. Tests that care about the unconfigured path delete it.
process.env["SECRET_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

// Path confinement resolves against this, so it must not be the real projects
// directory. Each suite creates and removes its own subdirectory beneath it.
process.env["PROJECTS_DIR"] ??= path.join(os.tmpdir(), "replit-clone-tests");

// Same reason as PROJECTS_DIR: publishing writes real files, and the suite must
// not be able to reach the directory a developer's own server serves from.
process.env["DEPLOYMENTS_DIR"] ??= path.join(
  os.tmpdir(),
  "replit-clone-tests-deployments",
);
