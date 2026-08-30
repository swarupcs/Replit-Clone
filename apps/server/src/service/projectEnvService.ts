import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { databaseEnv } from "./managedDatabaseService.js";
import { BadRequestError } from "../utils/errors.js";
import { isSecretBoxConfigured, looksSealed, open, seal } from "../lib/secretBox.js";
import { logger } from "../lib/logger.js";

/** Per-project environment variables.
 *
 *  Stored on the project row rather than in a dotfile in the working tree, so
 *  they are not committed by the user's own git, not included in an export, and
 *  not readable through the file tree.
 *
 *  Docker fixes a container's environment when it is CREATED, and a stopped
 *  container is reused rather than rebuilt — so for a while these took effect
 *  only on a project that had never been opened. Containers now carry a label
 *  recording which set they were built with, and one holding a stale set is
 *  rebuilt on its next start. Restart is the shortest way to reach that.
 *
 *  **Values are encrypted at rest**, each one sealed on its own under
 *  `SECRET_ENCRYPTION_KEY`. This column is where people put
 *  `STRIPE_SECRET_KEY` and `OPENAI_API_KEY`, and it was the last secret in the
 *  schema stored in the clear — the GitHub token, the database connection
 *  string and the managed database's password have all been sealed since they
 *  were added. A dump of this table used to be a list of everybody's live
 *  credentials.
 *
 *  Names are NOT sealed. The name is not the secret, the platform validates it
 *  against `RESERVED`, and an operator debugging a container has to be able to
 *  see which variables exist. Sealing values one at a time rather than the
 *  object as a whole keeps that possible, and means one unreadable value costs
 *  one variable rather than all of them.
 *
 *  Two things follow from being able to read rows written before this existed:
 *  a value is opened only when it has the SHAPE of a sealed value, so a
 *  ciphertext that will not open under the current key fails loudly instead of
 *  being mistaken for plaintext; and `backfillSealedEnvVars` exists to seal
 *  what is already there, since a SQL migration cannot reach a key that lives
 *  in the environment.
 */

/** POSIX-ish: a name the shell can actually export. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the platform sets itself. Letting a project override these would let
 *  it point its own dev server somewhere the proxy cannot reach, or shadow the
 *  home directory the package caches live under. */
const RESERVED = new Set(["HOME", "PATH", "HOSTNAME", "PREVIEW_BASE", "DEV_PORT"]);

const MAX_VARIABLES = 100;
const MAX_VALUE_LENGTH = 4096;

export const envVarsSchema = z
  .record(
    z.string().regex(NAME_PATTERN, "Names must look like MY_VARIABLE"),
    z.string().max(MAX_VALUE_LENGTH, "Value is too long"),
  )
  .refine(
    (value) => Object.keys(value).length <= MAX_VARIABLES,
    `At most ${String(MAX_VARIABLES)} variables`,
  )
  .refine(
    (value) => Object.keys(value).every((name) => !RESERVED.has(name)),
    `These names are set by the platform: ${[...RESERVED].join(", ")}`,
  );

export type EnvVars = z.infer<typeof envVarsSchema>;

/** Whether this server can seal anything at all.
 *
 *  Read at call time, like everything else that consults the secret box. An
 *  install that has never set `SECRET_ENCRYPTION_KEY` keeps working with
 *  plaintext rather than losing a core feature over a key it was never asked
 *  for — but it is told, loudly and once, rather than left to assume the
 *  column is protected.
 */
let warnedUnconfigured = false;

function canSeal(): boolean {
  if (isSecretBoxConfigured()) return true;

  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    logger.warn(
      "SECRET_ENCRYPTION_KEY is not set, so project environment variables " +
        "are stored in plain text. Anything in them is readable by anybody " +
        "who can read the database. Generate a key with: openssl rand -base64 32",
    );
  }

  return false;
}

/** Exposed so the UI can say so rather than implying a protection that is not
 *  there. A panel that looks identical either way is a panel that lies on one
 *  of the two servers. */
export function envVarsEncryptedAtRest(): boolean {
  return isSecretBoxConfigured();
}

/** Opens one stored value.
 *
 *  Shape decides the branch, not whether `open` threw — see `looksSealed`. A
 *  value that looks sealed and will not open is a wrong key or a tampered row,
 *  and both are worth failing on rather than papering over by returning the
 *  ciphertext as if it were the secret.
 */
function openValue(name: string, stored: string): string | undefined {
  if (!looksSealed(stored)) return stored;

  try {
    return open(stored);
  } catch {
    // One variable is dropped, not the whole set: a project with nine readable
    // variables and one unreadable one should start with nine.
    logger.error("could not decrypt an environment variable", { name });
    return undefined;
  }
}

/** Reads a project's variables, tolerating a row written before this existed
 *  or by hand. */
export function parseEnvVars(raw: unknown): EnvVars {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const result: EnvVars = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || !NAME_PATTERN.test(name)) continue;

    const opened = openValue(name, value);
    if (opened !== undefined) result[name] = opened;
  }

  return result;
}

/** The stored form of a set of variables: names as they are, values sealed. */
function sealAll(vars: EnvVars): Record<string, string> {
  if (!canSeal()) return { ...vars };

  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [name, seal(value)]),
  );
}

export async function getEnvVars(projectId: string): Promise<EnvVars> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { envVars: true },
  });

  const own = parseEnvVars(project?.envVars);

  // A managed database's URL joins here rather than being added at container
  // start, and that placement is the point: `envSignature` is computed from
  // whatever this returns, so provisioning a database changes the signature
  // and forces the rebuild that gives the container its DATABASE_URL. A
  // container started before the database would otherwise keep the old,
  // absent value for the rest of its life.
  //
  // The user's own value wins. Someone who has set DATABASE_URL by hand has
  // said which database they mean, and silently overriding it would be the
  // platform arguing with them.
  const managed = await databaseEnv(projectId).catch(() => ({}));
  return { ...managed, ...own };
}

export async function setEnvVars(
  projectId: string,
  vars: unknown,
): Promise<EnvVars> {
  const parsed = envVarsSchema.safeParse(vars);

  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
      "INVALID_ENV_VARS",
    );
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { envVars: sealAll(parsed.data) },
  });

  // The plaintext the caller sent, not a re-read: they are entitled to it,
  // they just typed it, and a round trip through the column would only prove
  // the cipher works.
  return parsed.data;
}

/** Seals any variables still stored in the clear.
 *
 *  A SQL migration cannot do this — the key lives in the environment, which is
 *  exactly the property that makes a leaked dump worthless — so it runs at
 *  boot instead. Idempotent, and a no-op on a server with no key or nothing
 *  left to seal.
 *
 *  Deliberately not lazy-on-read: reads do not write, so a project nobody
 *  opens would keep its secrets in the clear forever, and those are precisely
 *  the projects nobody is watching.
 */
export async function backfillSealedEnvVars(
  projectIds?: string[],
): Promise<{ sealed: number }> {
  if (!isSecretBoxConfigured()) return { sealed: 0 };

  const rows = await prisma.project.findMany({
    where: {
      NOT: { envVars: { equals: {} } },
      // Boot passes nothing and sweeps everything, which is the point. The
      // argument exists because a sweep over every row in the database is also
      // the one thing a test cannot do politely: the suite covering this ran
      // against a shared database and sealed OTHER suites' projects under a key
      // only its own worker had, so their variables became unreadable and they
      // failed somewhere else entirely. It is useful operationally too — a
      // backfill that can be aimed at one project is what you want when one
      // project is the problem.
      ...(projectIds ? { id: { in: projectIds } } : {}),
    },
    select: { id: true, envVars: true },
  });

  let sealed = 0;

  for (const row of rows) {
    const stored = row.envVars;
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
      continue;
    }

    const entries = Object.entries(stored as Record<string, unknown>);
    const plain = entries.filter(
      ([, value]) => typeof value === "string" && !looksSealed(value),
    );
    if (plain.length === 0) continue;

    // Only the plaintext ones are sealed. Re-sealing an already-sealed value
    // would mean opening it first, which turns a backfill into something that
    // fails on a row it did not need to read.
    //
    // Non-string values are dropped rather than carried, because `parseEnvVars`
    // already ignores them — keeping them would preserve something no reader
    // will ever return.
    const next: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (typeof value !== "string") continue;
      next[name] = looksSealed(value) ? value : seal(value);
    }

    await prisma.project.update({
      where: { id: row.id },
      data: { envVars: next },
    });
    sealed += plain.length;
  }

  if (sealed > 0) {
    logger.info("sealed environment variables that were stored in the clear", {
      variables: sealed,
    });
  }

  return { sealed };
}

/** Renders the variables as Docker's `NAME=value` list. */
export function toDockerEnv(vars: EnvVars): string[] {
  return Object.entries(vars).map(([name, value]) => `${name}=${value}`);
}
