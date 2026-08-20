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

// Path confinement resolves against this, so it must not be the real projects
// directory. Each suite creates and removes its own subdirectory beneath it.
process.env["PROJECTS_DIR"] ??= path.join(os.tmpdir(), "replit-clone-tests");
