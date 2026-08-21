import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

/** Keeps database-backed suites out of each other's way.
 *
 *  Every one of these files used to start by truncating `users`, `projects`
 *  and friends. Vitest runs test FILES in parallel, so with more than one such
 *  file they delete rows the others have just inserted — and the next insert
 *  fails on a foreign key that was satisfied a moment earlier. The symptom is a
 *  different set of failures on every run.
 *
 *  It only stayed hidden while there was effectively one of them at a time.
 *  Running the whole suite spread the files across workers far enough apart to
 *  get away with it; running just the database ones together fails every time,
 *  which is what CI happened to do.
 *
 *  So no suite truncates anything. Each takes a scope, names its users through
 *  it, and removes only what it created. Everything else in the schema cascades
 *  from `User`, so that one delete is the whole cleanup.
 */
export interface DbScope {
  /** An address belonging to this suite and no other. */
  email: (label?: string) => string;
  /** Restricts a `user` query to this suite's rows. */
  readonly where: { email: { endsWith: string } };
  /** Removes everything this suite created. */
  cleanup: (prisma: PrismaClient) => Promise<void>;
}

/** `name` distinguishes one suite from another, so give it the file's own. */
export function dbScope(name: string): DbScope {
  // The name alone would collide if the same suite ran twice against one
  // database — a watch run, or two shards sharing it — so it carries a random
  // part as well.
  const suffix = `@${name}-${randomUUID().slice(0, 8)}.test`;

  return {
    email: (label = "user") => `${label}-${randomUUID()}${suffix}`,
    where: { email: { endsWith: suffix } },
    cleanup: async (prisma) => {
      await prisma.user.deleteMany({ where: { email: { endsWith: suffix } } });
    },
  };
}
